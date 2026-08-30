const { repairSubtitleLayout } = require("../src/services/subtitleLayout");

const sourceId = process.argv[2];
if (!sourceId) throw new Error("Use: node scripts/repair-subtitle-layout.js SOURCE_ID");
console.log(JSON.stringify(repairSubtitleLayout(sourceId, { backup: true, force: true })));
