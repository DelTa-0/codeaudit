// Minimal fixture with genuinely zero dead-code candidates: every symbol is
// referenced from within its own file, so findDeadCodeCandidates finds
// nothing to flag (see packages/engine/src/deadcode.ts).
function helper() {
  return 1;
}

function run() {
  return helper();
}

run();
