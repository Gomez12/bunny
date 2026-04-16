import type { Database } from "bun:sqlite";

export interface DashboardParams {
  fromTs: number;
  bucketMs: number;
  userId?: string;
}

export interface DashboardData {
  kpi: {
    totalMessages: number;
    totalSessions: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    avgResponseMs: number | null;
  };
  activityOverTime: Array<{ ts: number; count: number }>;
  tokensOverTime: Array<{ ts: number; prompt: number; completion: number }>;
  responseTimeOverTime: Array<{ ts: number; avgMs: number }>;
  toolUsage: Array<{ name: string; count: number }>;
  agentActivity: Array<{ agent: string; count: number }>;
  projectActivity: Array<{ project: string; count: number }>;
  boardOverview: Array<{ lane: string; count: number }>;
  cardRunStatus: Array<{ status: string; count: number }>;
  errorRate: { total: number; errors: number };
  recentActivity: Array<{
    id: number;
    ts: number;
    topic: string;
    kind: string;
    sessionId: string | null;
    userId: string | null;
    durationMs: number | null;
    error: string | null;
  }>;
  scheduler: {
    total: number;
    enabled: number;
    errored: number;
    nextDue: number | null;
  };
}

function userClause(userId: string | undefined, prefix = "AND"): { sql: string; params: (string | number)[] } {
  if (!userId) return { sql: "", params: [] };
  return { sql: `${prefix} user_id = ?`, params: [userId] };
}

export function getDashboardStats(db: Database, p: DashboardParams): DashboardData {
  const { fromTs, bucketMs, userId } = p;
  const uc = userClause(userId);

  const kpiRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total_messages,
         COUNT(DISTINCT session_id) AS total_sessions,
         COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
         AVG(CASE WHEN role = 'assistant' AND channel = 'content' AND duration_ms IS NOT NULL
             THEN duration_ms END) AS avg_response_ms
       FROM messages
       WHERE ts >= ? AND channel = 'content' AND role IN ('user', 'assistant')
       ${uc.sql}`,
    )
    .get(fromTs, ...uc.params) as {
    total_messages: number;
    total_sessions: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    avg_response_ms: number | null;
  };

  const activityOverTime = db
    .prepare(
      `SELECT (ts / ?) * ? AS bucket, COUNT(*) AS count
       FROM messages
       WHERE ts >= ? AND role IN ('user', 'assistant') AND channel = 'content'
       ${uc.sql}
       GROUP BY bucket ORDER BY bucket`,
    )
    .all(bucketMs, bucketMs, fromTs, ...uc.params) as Array<{ bucket: number; count: number }>;

  const tokensOverTime = db
    .prepare(
      `SELECT (ts / ?) * ? AS bucket,
         COALESCE(SUM(prompt_tokens), 0) AS prompt,
         COALESCE(SUM(completion_tokens), 0) AS completion
       FROM messages
       WHERE ts >= ? AND channel = 'content' AND prompt_tokens IS NOT NULL
       ${uc.sql}
       GROUP BY bucket ORDER BY bucket`,
    )
    .all(bucketMs, bucketMs, fromTs, ...uc.params) as Array<{
    bucket: number;
    prompt: number;
    completion: number;
  }>;

  const responseTimeOverTime = db
    .prepare(
      `SELECT (ts / ?) * ? AS bucket, AVG(duration_ms) AS avg_ms
       FROM messages
       WHERE ts >= ? AND role = 'assistant' AND channel = 'content' AND duration_ms IS NOT NULL
       ${uc.sql}
       GROUP BY bucket ORDER BY bucket`,
    )
    .all(bucketMs, bucketMs, fromTs, ...uc.params) as Array<{ bucket: number; avg_ms: number }>;

  const toolUsage = db
    .prepare(
      `SELECT tool_name AS name, COUNT(*) AS count
       FROM messages
       WHERE ts >= ? AND channel = 'tool_call' AND tool_name IS NOT NULL
       ${uc.sql}
       GROUP BY tool_name ORDER BY count DESC LIMIT 15`,
    )
    .all(fromTs, ...uc.params) as Array<{ name: string; count: number }>;

  const agentActivity = db
    .prepare(
      `SELECT COALESCE(author, '(default)') AS agent, COUNT(*) AS count
       FROM messages
       WHERE ts >= ? AND role = 'assistant' AND channel = 'content'
       ${uc.sql}
       GROUP BY agent ORDER BY count DESC LIMIT 10`,
    )
    .all(fromTs, ...uc.params) as Array<{ agent: string; count: number }>;

  const projectActivity = db
    .prepare(
      `SELECT COALESCE(project, 'general') AS project, COUNT(*) AS count
       FROM messages
       WHERE ts >= ? AND channel = 'content'
       ${uc.sql}
       GROUP BY project ORDER BY count DESC LIMIT 10`,
    )
    .all(fromTs, ...uc.params) as Array<{ project: string; count: number }>;

  const boardOverview = db
    .prepare(
      `SELECT s.name AS lane, COUNT(c.id) AS count
       FROM board_swimlanes s
       LEFT JOIN board_cards c ON c.swimlane_id = s.id AND c.archived_at IS NULL
       GROUP BY s.id, s.name
       ORDER BY s.position`,
    )
    .all() as Array<{ lane: string; count: number }>;

  const cardRunStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS count
       FROM board_card_runs
       WHERE started_at >= ?
       GROUP BY status`,
    )
    .all(fromTs) as Array<{ status: string; count: number }>;

  const errorRateRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN error IS NOT NULL THEN 1 END) AS errors
       FROM events
       WHERE ts >= ?
       ${uc.sql}`,
    )
    .get(fromTs, ...uc.params) as { total: number; errors: number };

  const recentActivityRows = db
    .prepare(
      `SELECT id, ts, topic, kind, session_id, user_id, duration_ms, error
       FROM events
       WHERE ts >= ?
       ${uc.sql}
       ORDER BY ts DESC LIMIT 20`,
    )
    .all(fromTs, ...uc.params) as Array<{
    id: number;
    ts: number;
    topic: string;
    kind: string;
    session_id: string | null;
    user_id: string | null;
    duration_ms: number | null;
    error: string | null;
  }>;

  const schedulerRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN enabled = 1 THEN 1 END) AS enabled,
         COUNT(CASE WHEN last_status = 'error' THEN 1 END) AS errored,
         MIN(CASE WHEN enabled = 1 THEN next_run_at END) AS next_due
       FROM scheduled_tasks`,
    )
    .get() as { total: number; enabled: number; errored: number; next_due: number | null };

  return {
    kpi: {
      totalMessages: kpiRow.total_messages,
      totalSessions: kpiRow.total_sessions,
      totalPromptTokens: kpiRow.total_prompt_tokens,
      totalCompletionTokens: kpiRow.total_completion_tokens,
      avgResponseMs: kpiRow.avg_response_ms,
    },
    activityOverTime: activityOverTime.map((r) => ({ ts: r.bucket, count: r.count })),
    tokensOverTime: tokensOverTime.map((r) => ({
      ts: r.bucket,
      prompt: r.prompt,
      completion: r.completion,
    })),
    responseTimeOverTime: responseTimeOverTime.map((r) => ({ ts: r.bucket, avgMs: r.avg_ms })),
    toolUsage,
    agentActivity,
    projectActivity,
    boardOverview,
    cardRunStatus,
    errorRate: { total: errorRateRow.total, errors: errorRateRow.errors },
    recentActivity: recentActivityRows.map((r) => ({
      id: r.id,
      ts: r.ts,
      topic: r.topic,
      kind: r.kind,
      sessionId: r.session_id,
      userId: r.user_id,
      durationMs: r.duration_ms,
      error: r.error,
    })),
    scheduler: {
      total: schedulerRow.total,
      enabled: schedulerRow.enabled,
      errored: schedulerRow.errored,
      nextDue: schedulerRow.next_due,
    },
  };
}
