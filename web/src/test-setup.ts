import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Tell React it is being tested.
 *
 * Without it, anything wrapped in `act` warns that the environment does not
 * support it — on every call, in every test that changes state from outside a
 * component. The warning is correct and the fix is this flag; leaving it to
 * scroll past would train everybody to ignore the one place React reports a
 * genuine problem.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
