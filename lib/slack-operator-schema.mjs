export function initSlackOperator(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_operator_config(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,mode TEXT NOT NULL DEFAULT 'review');
    INSERT OR IGNORE INTO slack_operator_config(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS slack_operator_members(user_id TEXT PRIMARY KEY,member_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS slack_operator_threads(thread_key TEXT PRIMARY KEY,history TEXT NOT NULL DEFAULT '[]',pending TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS slack_operator_requests(request_id TEXT PRIMARY KEY,thread_key TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL);
  `)
}
