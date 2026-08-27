export const CALLABLE = "__orogenyBridge";

export const source = (
  url: string,
  token: string,
  notebookId: string,
) => `const ${CALLABLE} = (() => {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  return async (operation: string, input: unknown = null): Promise<unknown> => {
    const response = await nativeFetch(${JSON.stringify(`${url}/bridge`)}, {
      method: "POST",
      headers: {
        "authorization": ${JSON.stringify(`Bearer ${token}`)},
        "content-type": "application/json",
      },
      body: JSON.stringify({
        notebookId: ${JSON.stringify(notebookId)},
        operation,
        input,
      }),
    });
    const result = await response.json();
    if (result.ok) return result.value;
    const error = new Error(result.error.message);
    error.name = result.error.name;
    if (result.error.data !== undefined) {
      Object.defineProperty(error, "data", {
        value: result.error.data,
        enumerable: true,
      });
    }
    throw error;
  };
})();`;
