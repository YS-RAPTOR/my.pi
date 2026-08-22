import Parser from "tree-sitter";
import { Array as Arr, Chunk, Data, HashMap, Option, Order, pipe } from "effect";
import { PreparedQuery, Segment } from "./query.ts";

export class Highlight extends Data.Class<{
  readonly name: string;
  readonly startIndex: number;
  readonly endIndex: number;
}> {}

export class Candidate extends Data.Class<{
  readonly name: Option.Option<string>;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly depth: number;
  readonly priority: number;
  readonly pattern: number;
  readonly order: number;
}> {}

const fromSegment = (
  name: Option.Option<string>,
  segment: Segment,
  depth: number,
  priority: number,
  pattern: number,
  order: number,
) =>
  new Candidate({
    name,
    startIndex: segment.sourceStart,
    endIndex: segment.sourceStart + segment.generatedEnd - segment.generatedStart,
    depth,
    priority,
    pattern,
    order,
  });

export const captureCandidates = (
  query: Option.Option<PreparedQuery>,
  source: string,
  tree: Parser.Tree,
  depth: number,
) =>
  pipe(
    query,
    Option.match({
      onNone: Chunk.empty<Candidate>,
      onSome: (prepared) => {
        let order = 0;

        return pipe(
          prepared.run(source, tree),
          Chunk.flatMap((match) => {
            const value = pipe(
              HashMap.get(match.properties, "priority"),
              Option.flatMap(Option.fromNullishOr),
              Option.map(Number),
              Option.filter(Number.isFinite),
              Option.getOrElse(() => 100),
            );

            return pipe(
              match.captures,
              Chunk.filter(({ name }) => !name.startsWith("_")),
              Chunk.flatMap((capture) => {
                const captureOrder = order++;

                return pipe(
                  capture.segments,
                  Chunk.map((segment) =>
                    fromSegment(
                      Option.some(capture.name),
                      segment,
                      depth,
                      value,
                      match.pattern,
                      captureOrder,
                    ),
                  ),
                );
              }),
            );
          }),
          Chunk.filter(({ startIndex, endIndex }) => startIndex < endIndex),
        );
      },
    }),
  );

export const mapCandidates = (
  candidates: Chunk.Chunk<Candidate>,
  segments: Chunk.Chunk<Segment>,
) =>
  pipe(
    candidates,
    Chunk.flatMap((candidate) =>
      pipe(
        segments,
        Chunk.flatMap((segment) => {
          const start = Math.max(candidate.startIndex, segment.generatedStart);
          const end = Math.min(candidate.endIndex, segment.generatedEnd);

          if (start >= end) return Chunk.empty<Candidate>();

          return Chunk.of(
            new Candidate({
              ...candidate,
              startIndex: segment.sourceStart + start - segment.generatedStart,
              endIndex: segment.sourceStart + end - segment.generatedStart,
            }),
          );
        }),
      ),
    ),
  );

export const maskCandidates = (segments: Chunk.Chunk<Segment>, depth: number) =>
  pipe(
    segments,
    Chunk.map((segment) =>
      fromSegment(Option.none(), segment, depth, Number.NEGATIVE_INFINITY, -1, -1),
    ),
  );

const precedence = Order.combineAll<Candidate>([
  Order.mapInput(Order.Number, ({ depth }) => depth),
  Order.mapInput(Order.Number, ({ priority }) => priority),
  Order.mapInput(
    Order.flip(Order.Number),
    ({ startIndex, endIndex }) => endIndex - startIndex,
  ),
  Order.mapInput(Order.Number, ({ pattern }) => pattern),
  Order.mapInput(Order.Number, ({ order }) => order),
]);

const push = (heap: Array<Candidate>, candidate: Candidate) => {
  let index = heap.push(candidate) - 1;

  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (precedence(heap[parent]!, candidate) >= 0) break;
    heap[index] = heap[parent]!;
    index = parent;
  }

  heap[index] = candidate;
};

const pop = (heap: Array<Candidate>) => {
  const last = heap.pop();
  if (last === undefined || heap.length === 0) return;

  let index = 0;

  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) break;

    const child =
      right < heap.length && precedence(heap[right]!, heap[left]!) > 0 ? right : left;
    if (precedence(last, heap[child]!) >= 0) break;

    heap[index] = heap[child]!;
    index = child;
  }

  heap[index] = last;
};

export const resolve = (input: Chunk.Chunk<Candidate>) => {
  const candidates = Arr.sortWith(input, ({ startIndex }) => startIndex, Order.Number);
  const points = pipe(
    candidates,
    Arr.flatMap(({ startIndex, endIndex }) => [startIndex, endIndex]),
    Arr.dedupe,
    Arr.sort(Order.Number),
  );
  const heap: Array<Candidate> = [];
  const output: Array<Highlight> = [];
  let candidateIndex = 0;

  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex++) {
    const startIndex = points[pointIndex]!;
    const endIndex = points[pointIndex + 1]!;

    while (
      candidateIndex < candidates.length &&
      candidates[candidateIndex]!.startIndex <= startIndex
    ) {
      push(heap, candidates[candidateIndex++]!);
    }

    while (heap[0] !== undefined && heap[0].endIndex <= startIndex) pop(heap);

    const winner = heap[0];
    if (winner === undefined || Option.isNone(winner.name)) continue;

    const previous = output.at(-1);

    if (previous?.name === winner.name.value && previous.endIndex === startIndex) {
      output[output.length - 1] = new Highlight({
        name: previous.name,
        startIndex: previous.startIndex,
        endIndex,
      });
    } else {
      output.push(new Highlight({ name: winner.name.value, startIndex, endIndex }));
    }
  }

  return Chunk.fromIterable(output);
};
