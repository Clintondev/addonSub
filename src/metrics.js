const counters = {
  jobs_total: 0,
  jobs_failed: 0,
  translations_total: 0,
  cache_hits: 0,
  extraction_failed: 0,
};

function inc(name, value = 1) {
  counters[name] = (counters[name] || 0) + value;
}

function getMetricsText() {
  return Object.entries(counters)
    .map(([k, v]) => `${k} ${v}`)
    .join("\n");
}

module.exports = {
  inc,
  getMetricsText,
};
