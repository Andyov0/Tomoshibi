import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Take each rendered tree down before the next test puts one up.
 *
 * Testing Library does this on its own when Vitest is run with globals, and this
 * project imports its test functions by name instead, so nothing was doing it.
 * That went unnoticed for as long as every test asked its questions of the
 * container it had just rendered; the first one to ask the document a question
 * found the previous test's menu still open and answered from it.
 *
 * A leak of that shape does not fail honestly. It makes tests pass in one order
 * and fail in another, and the test that breaks is rarely the one at fault.
 */
afterEach(cleanup);
