const test = require("node:test");
const assert = require("node:assert/strict");
const { runProcess } = require("../src/utils/processRunner");

test("runs media subprocesses without blocking the Node event loop", async () => {
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 20);
  const result = await runProcess(process.execPath, ["-e", "setTimeout(() => process.stdout.write('ok'), 80)"], { timeoutMs: 2000 });
  clearTimeout(timer);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(timerRan, true);
});

test("terminates a subprocess after its configured deadline", async () => {
  const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.status, 0);
});
