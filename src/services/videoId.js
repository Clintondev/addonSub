const IMDB_ID = /^tt\d+$/;
const EPISODE_ID = /^(tt\d+):(\d+):(\d+)$/;

function parseVideoId(type, id) {
  if (type === "movie" && IMDB_ID.test(id)) return { type, imdbId: id, videoId: id };
  const match = type === "series" && EPISODE_ID.exec(id);
  if (match) return { type, imdbId: match[1], season: Number(match[2]), episode: Number(match[3]), videoId: id };
  throw new Error("Invalid Stremio video id");
}

module.exports = { parseVideoId };
