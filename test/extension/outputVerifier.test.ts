// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import assert = require("assert");
import { ChildProcess } from "child_process";
import { PassThrough } from "stream";
import { InternalError } from "../../src/common/error/internalError";
import { InternalErrorCode } from "../../src/common/error/internalErrorCode";
import { ISpawnResult } from "../../src/common/node/childProcess";
import { OutputVerifier, PatternToFailure } from "../../src/common/outputVerifier";

suite("OutputVerifier", function () {
    function verify(
        successPatterns: string[],
        failurePatterns: PatternToFailure[],
        stdoutChunks: string[] = [],
        stderrChunks: string[] = [],
        processError?: Error,
    ): Promise<void> {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        let finish: () => void;
        let fail: (error: Error) => void;
        const outcome = new Promise<void>((resolve, reject) => {
            finish = resolve;
            fail = reject;
        });
        const spawnResult: ISpawnResult = {
            spawnedProcess: {} as ChildProcess,
            stdin,
            stdout,
            stderr,
            outcome,
        };
        const verifier = new OutputVerifier(
            async () => successPatterns,
            async () => failurePatterns,
            "android",
        );
        const result = verifier.process(spawnResult);
        stdoutChunks.forEach(chunk => stdout.write(chunk));
        stderrChunks.forEach(chunk => stderr.write(chunk));
        if (processError) {
            fail!(processError);
        } else {
            finish!();
        }
        return result.finally(() => {
            stdin.destroy();
            stdout.destroy();
            stderr.destroy();
        });
    }

    test("matches all success patterns case-insensitively across output chunks", async function () {
        await verify(["build succeeded", "installed"], [], ["BUILD suc", "ceeded\nINSTALLED"]);
    });

    test("accepts a successful process when no success patterns are required", async function () {
        await verify([], []);
    });

    test("rejects when any required success pattern is missing", async function () {
        await assert.rejects(
            verify(["built", "installed"], [], ["built"]),
            (error: InternalError) => {
                assert.strictEqual(error.errorCode, InternalErrorCode.NotAllSuccessPatternsMatched);
                assert.ok(error.message.includes("android"));
                return true;
            },
        );
    });

    test("does not match success patterns from stderr", async function () {
        await assert.rejects(verify(["built"], [], [], ["built"]), (error: InternalError) => {
            assert.strictEqual(error.errorCode, InternalErrorCode.NotAllSuccessPatternsMatched);
            return true;
        });
    });

    for (const stream of ["stdout", "stderr"]) {
        test(`rejects a matching string failure on ${stream} even when success matches`, async function () {
            const failures = [
                { pattern: "fatal error", errorCode: InternalErrorCode.CommandFailed },
            ];
            await assert.rejects(
                verify(
                    ["built"],
                    failures,
                    stream === "stdout" ? ["built fatal error"] : ["built"],
                    stream === "stderr" ? ["fatal error"] : [],
                ),
                (error: InternalError) => {
                    assert.strictEqual(error.errorCode, InternalErrorCode.CommandFailed);
                    return true;
                },
            );
        });
    }

    test("matches a regular expression failure split across chunks", async function () {
        await assert.rejects(
            verify(
                [],
                [{ pattern: /fatal\s+error/, errorCode: InternalErrorCode.CommandFailed }],
                [],
                ["fatal ", "error"],
            ),
            (error: InternalError) => {
                assert.strictEqual(error.errorCode, InternalErrorCode.CommandFailed);
                assert.ok(error.message.includes("fatal error"));
                return true;
            },
        );
    });

    test("ignores unmatched failure patterns", async function () {
        await verify(
            ["built"],
            [{ pattern: "fatal error", errorCode: InternalErrorCode.CommandFailed }],
            ["built"],
            ["a warning"],
        );
    });

    test("preserves the original process failure when no failure pattern matches", async function () {
        const processError = new Error("process exited with code 1");
        await assert.rejects(
            verify(["built"], [], [], [], processError),
            (error: Error) => error === processError,
        );
    });

    test("adds a matched failure diagnostic without replacing the process error", async function () {
        const processError = new Error("process exited with code 1");
        await assert.rejects(
            verify(
                [],
                [{ pattern: /fatal error/, errorCode: InternalErrorCode.CommandFailed }],
                [],
                ["fatal error"],
                processError,
            ),
            (error: Error) => {
                assert.strictEqual(error, processError);
                assert.ok(processError.message.startsWith("process exited with code 1\n"));
                assert.ok(processError.message.includes("fatal error"));
                return true;
            },
        );
    });
});
