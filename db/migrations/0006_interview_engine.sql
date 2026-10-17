-- Sprint 4: interview engine. Activity history for interviews, plus indexes for the calendar and the
-- feedback SLA reports.

-- Append-only history of what happened to an interview: scheduled, rescheduled (with a reason),
-- cancelled (with a reason), completed, panel changes, feedback links issued or revoked.
CREATE TABLE interview_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    interview_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, interview_id) REFERENCES interviews(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_interview_events_interview ON interview_events(interview_id, created_at);

CREATE TRIGGER trg_interview_events_append_only
    BEFORE UPDATE OR DELETE ON interview_events
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE interview_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON interview_events
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Calendar and "my interviews".
CREATE INDEX idx_interviews_application ON interviews(tenant_id, application_id);
CREATE INDEX idx_interviewers_user ON interviewers(tenant_id, user_id) WHERE user_id IS NOT NULL;

-- Feedback SLA: pending feedback on interviews that still count.
CREATE INDEX idx_interviews_feedback_due ON interviews(tenant_id, feedback_due_at)
    WHERE status NOT IN ('cancelled', 'no_show');
CREATE INDEX idx_interviewers_pending ON interviewers(tenant_id, interview_id) WHERE feedback_status = 'pending';

-- Notification centre and the delivery worker.
CREATE INDEX idx_tasks_assignee ON tasks(tenant_id, assignee_user_id, created_at DESC);
CREATE UNIQUE INDEX uq_tasks_dedupe ON tasks(tenant_id, assignee_user_id, task_type, entity_id)
    WHERE completed_at IS NULL AND entity_id IS NOT NULL;

-- Feedback submitted by someone with an account (not through a link) records which link, if any.
-- Rating bounds for scorecard competencies are validated by the application against the template.
