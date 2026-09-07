const { spawn } = require("child_process");

const minimums = { lines: 60, branches: 70, functions: 65 };
const child = spawn(process.execPath, ["--test", "--experimental-test-coverage"], {
  stdio: ["inherit", "pipe", "pipe"],
});
let output = "";

child.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
child.stderr.pipe(process.stderr);
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (code !== 0) {
    process.exitCode = code || 1;
    return;
  }
  const aggregate = output.match(/# all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/);
  if (!aggregate) {
    console.error("Could not read the aggregate test coverage report");
    process.exitCode = 1;
    return;
  }
  const actual = { lines: Number(aggregate[1]), branches: Number(aggregate[2]), functions: Number(aggregate[3]) };
  const failures = Object.entries(minimums)
    .filter(([metric, minimum]) => actual[metric] < minimum)
    .map(([metric, minimum]) => `${metric}: ${actual[metric]}% < ${minimum}%`);
  if (failures.length) {
    console.error(`Coverage thresholds not met: ${failures.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`Coverage thresholds met: lines ${actual.lines}%, branches ${actual.branches}%, functions ${actual.functions}%`);
  }
  if (signal) process.exitCode = 1;
});
