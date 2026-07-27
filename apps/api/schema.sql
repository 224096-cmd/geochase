-- GeoChase D1 schema (v2)
--
-- v1では guesses が rounds/users を外部キー参照していたが、
-- 親レコードを一度も作っていなかったため INSERT が常に失敗していた。
-- 実際に必要なのは「回答ログ」と「最終スコア」の2つなので、
-- 参照整合性は持たせず room_id で紐付けるフラットな構成にする。

DROP TABLE IF EXISTS guesses;

CREATE TABLE IF NOT EXISTS guesses (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  round_no    INTEGER NOT NULL,
  user_id     TEXT,
  player_name TEXT,
  mode        TEXT NOT NULL,
  region      TEXT NOT NULL,
  guess_lat   REAL NOT NULL,
  guess_lng   REAL NOT NULL,
  distance_km REAL NOT NULL,
  score       INTEGER NOT NULL,
  guessed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  player_name TEXT,
  mode        TEXT NOT NULL,
  region      TEXT NOT NULL,
  rounds      INTEGER NOT NULL,
  total_score INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guesses_room ON guesses(room_id, round_no);
CREATE INDEX IF NOT EXISTS idx_guesses_time ON guesses(guessed_at);
CREATE INDEX IF NOT EXISTS idx_results_rank ON results(mode, total_score DESC);