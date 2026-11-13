// Kept from the removed test:live attention phase (scripts/live/attention.ts, local-factory
// port): db/queries/restated-rules.test.ts holds failure-groups.sql to this independent restatement.

/**
 * The signatures of unresolved failures, read apart from failure-groups.sql (owner change 4 of
 * 2026-11-12, issue #647): $2 is the instant 7 days ago. A failed run is resolved when its item is closed
 * (the issue, else the PR), when a later completed run of its workflow is on the same issue (claim, else
 * facts step, else input) or, with no issue, the same PR (with no item at all, on anything), or when it
 * stopped at or before $2. A transient failure (issue #628) is also resolved by a later completed run of
 * its workflow on any item.
 */
export const FAILED_SIGNATURES_SQL = `WITH item AS (
    SELECT l.run_id,
      coalesce(
        (SELECT c.issue_number FROM mc.claims c WHERE c.factory = l.factory AND c.run_id = l.run_id
          ORDER BY c.claimed_at DESC NULLS LAST, c.issue_number LIMIT 1),
        (SELECT (f.output -> 'item' ->> 'number')::int FROM mc.lap_steps f WHERE f.run_id = l.run_id AND f.step_id = 'facts'),
        l.issue_number) AS issue,
      (SELECT min(p.pr_number) FROM mc.lap_steps p WHERE p.run_id = l.run_id) AS pr
    FROM mc.laps l WHERE l.factory = $1
  ), stop AS (
    SELECT s.signature, s.class, s.status, s.workflow_name, s.stopped_at, i.issue,
      CASE WHEN i.issue IS NULL THEN i.pr END AS pr,
      CASE WHEN i.issue IS NOT NULL
        THEN EXISTS (SELECT 1 FROM mc.issues x WHERE x.factory = s.factory AND x.number = i.issue AND x.state = 'closed')
        ELSE EXISTS (SELECT 1 FROM mc.pull_requests x WHERE x.factory = s.factory AND x.number = i.pr AND x.state = 'closed')
      END AS closed
    FROM mc.run_stops s LEFT JOIN item i ON i.run_id = s.run_id WHERE s.factory = $1
  )
  SELECT DISTINCT f.signature FROM stop f
  WHERE f.status = 'failed'
    AND (f.stopped_at IS NULL OR f.stopped_at > $2::timestamptz)
    AND NOT f.closed
    AND NOT EXISTS (
      SELECT 1 FROM stop o WHERE o.status = 'completed' AND o.workflow_name = f.workflow_name
        AND ((f.issue IS NULL AND f.pr IS NULL) OR o.issue = f.issue OR o.pr = f.pr) AND o.stopped_at > f.stopped_at)
    AND NOT (coalesce(f.class = 'transient', false) AND EXISTS (
      SELECT 1 FROM stop o WHERE o.status = 'completed' AND o.workflow_name = f.workflow_name
        AND o.stopped_at > f.stopped_at))
  ORDER BY 1`;
