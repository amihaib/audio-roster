// Minimal test helpers for plain `gjs -m`. No framework: each test file calls
// test(...) at import time; tests/run.js prints the summary and sets the exit code.

const results = {passed: 0, failed: 0};

export function test(name, fn) {
    try {
        fn();
        results.passed++;
        print(`  ok   ${name}`);
    } catch (e) {
        results.failed++;
        print(`  FAIL ${name}\n       ${e.message}`);
    }
}

export function assert(condition, message = 'assertion failed') {
    if (!condition)
        throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
    if (actual !== expected)
        throw new Error(`${message} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function assertDeepEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message} expected ${e}, got ${a}`);
}

export function assertThrows(fn, message = 'expected an exception') {
    let threw = false;
    try {
        fn();
    } catch (e) {
        threw = true;
    }
    if (!threw)
        throw new Error(message);
}

export function summary() {
    print(`\n${results.passed} passed, ${results.failed} failed`);
    return results.failed === 0;
}
