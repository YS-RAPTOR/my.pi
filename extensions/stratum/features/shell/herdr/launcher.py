import json
import os
import select
import signal
import socket
import stat
import time


def message_from(cause, fallback):
    message = str(cause)
    return message if message else fallback


def connect(options, socket_path):
    last_failure = None
    for attempt in range(options["connectionRetries"] + 1):
        peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        peer.settimeout(options["connectionTimeoutMillis"] / 1000)
        try:
            peer.connect(socket_path)
            peer.settimeout(None)
            return peer
        except OSError as cause:
            last_failure = cause
            peer.close()
            if attempt < options["connectionRetries"]:
                time.sleep(options["connectionRetryMillis"] / 1000)
    raise RuntimeError(
        message_from(last_failure, "Unable to connect to the Stratum launcher socket")
    )


def write_message(peer, message):
    encoded = json.dumps(message, separators=(",", ":")).encode() + b"\n"
    peer.sendall(encoded)


def wait_for_release(peer, timeout_millis):
    peer.settimeout(timeout_millis / 1000)
    response = bytearray()
    try:
        while b"\n" not in response:
            chunk = peer.recv(4096)
            if not chunk:
                raise RuntimeError("Stratum launcher connection closed before release")
            response.extend(chunk)
        message = json.loads(bytes(response).split(b"\n", 1)[0])
        if not isinstance(message, dict) or message.get("_tag") != "Release":
            raise RuntimeError("Unexpected Stratum launcher response")
    except socket.timeout as cause:
        raise RuntimeError("Timed out waiting for Stratum launcher release") from cause
    finally:
        peer.settimeout(None)


def read_descriptor():
    descriptor_path = os.environ.get("STRATUM_DESCRIPTOR")
    if descriptor_path is None:
        return None

    descriptor_stat = os.stat(descriptor_path)
    if stat.S_IMODE(descriptor_stat.st_mode) & 0o077:
        raise RuntimeError("Stratum command descriptor is not private")
    with open(descriptor_path, encoding="utf-8") as descriptor_file:
        descriptor = json.load(descriptor_file)
    os.remove(descriptor_path)
    return descriptor


def start_command(descriptor):
    read_status, write_status = os.pipe2(os.O_CLOEXEC)
    child_pid = os.fork()
    if child_pid == 0:
        os.close(read_status)
        try:
            signal.signal(signal.SIGTTOU, signal.SIG_IGN)
            os.setpgid(0, 0)
            os.tcsetpgrp(0, os.getpid())
            os.chdir(descriptor["cwd"])
            os.execve(
                "/bin/bash",
                ["/bin/bash", "-c", descriptor["cmd"]],
                descriptor["env"],
            )
        except BaseException as cause:
            try:
                os.write(write_status, str(cause).encode())
            finally:
                os._exit(127)

    os.close(write_status)
    with os.fdopen(read_status, "rb") as status:
        failure = status.read().decode()
    if failure:
        os.waitpid(child_pid, 0)
        return None, failure
    return child_pid, None


def wait_status(child_pid, peer):
    pid_fd = os.pidfd_open(child_pid)
    try:
        readable, _, _ = select.select([peer, pid_fd], [], [])
        if peer in readable and pid_fd not in readable:
            try:
                disconnected = peer.recv(1, socket.MSG_PEEK) == b""
            except OSError:
                disconnected = True
            if disconnected:
                os.killpg(child_pid, signal.SIGKILL)
                os.waitpid(child_pid, 0)
                raise RuntimeError("Stratum broker disconnected while Bash was running")
        _, status = os.waitpid(child_pid, 0)
    finally:
        os.close(pid_fd)
    if os.WIFEXITED(status):
        exit_code = os.WEXITSTATUS(status)
        return exit_code, None, exit_code
    if os.WIFSIGNALED(status):
        signal_number = os.WTERMSIG(status)
        signal_name = signal.Signals(signal_number).name
        return None, signal_name, 128 + signal_number
    raise RuntimeError("Bash returned an unsupported wait status")


def main(options):
    descriptor = read_descriptor()
    if descriptor is None:
        while True:
            time.sleep(2**30)
    if not isinstance(descriptor.get("controlSocket"), str) or not isinstance(
        descriptor.get("commandId"), str
    ):
        raise RuntimeError("Incomplete Stratum launcher control descriptor")

    peer = connect(options, descriptor["controlSocket"])
    try:
        try:
            child_pid, start_failure = start_command(descriptor)
        except BaseException as cause:
            child_pid = None
            start_failure = message_from(cause, "Unable to start Bash")
        if start_failure is not None:
            write_message(
                peer,
                {
                    "_tag": "StartFailed",
                    "commandId": descriptor["commandId"],
                    "message": start_failure,
                },
            )
            wait_for_release(peer, options["releaseTimeoutMillis"])
            return 127

        write_message(
            peer,
            {
                "_tag": "Started",
                "commandId": descriptor["commandId"],
                "processGroup": child_pid,
            },
        )
        exit_code, signal_name, launcher_exit_code = wait_status(child_pid, peer)
        write_message(
            peer,
            {
                "_tag": "Exited",
                "commandId": descriptor["commandId"],
                "exitCode": exit_code,
                "signal": signal_name,
            },
        )
        wait_for_release(peer, options["releaseTimeoutMillis"])
        return launcher_exit_code
    finally:
        peer.close()
