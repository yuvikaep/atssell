-- Sprint 6: offers and joining. Offers go through sequential approval rounds like requisitions do;
-- a released offer that is accepted creates the joining record that follow-up tasks hang off.

ALTER TABLE offer_approvals
    ADD COLUMN round INTEGER NOT NULL DEFAULT 1 CHECK (round > 0);
ALTER TABLE offer_approvals DROP CONSTRAINT offer_approvals_offer_id_step_order_key;
ALTER TABLE offer_approvals ADD CONSTRAINT offer_approvals_round_step_key UNIQUE (offer_id, round, step_order);

ALTER TABLE offers
    ADD COLUMN approval_round INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN notes TEXT,
    ADD COLUMN released_at TIMESTAMPTZ,
    ADD COLUMN responded_at TIMESTAMPTZ,
    ADD COLUMN withdrawn_reason TEXT,
    ADD CONSTRAINT offers_decline_reason_chk CHECK (status <> 'declined' OR decline_reason IS NOT NULL),
    ADD CONSTRAINT offers_withdraw_reason_chk CHECK (status <> 'withdrawn' OR withdrawn_reason IS NOT NULL);

-- One live offer per application; a declined or withdrawn one makes room for a new offer.
CREATE UNIQUE INDEX uq_offers_one_open ON offers(application_id) WHERE status IN ('draft', 'pending_approval', 'approved', 'released');
CREATE INDEX idx_offers_status ON offers(tenant_id, status, created_at DESC);
CREATE INDEX idx_offer_approvals_pending ON offer_approvals(approver_user_id) WHERE decision = 'pending';

ALTER TABLE joining_records
    ADD COLUMN offer_id UUID,
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD FOREIGN KEY (tenant_id, offer_id) REFERENCES offers(tenant_id, id);
CREATE INDEX idx_joining_status_date ON joining_records(tenant_id, status, joining_date);
