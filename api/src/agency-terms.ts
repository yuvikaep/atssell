import type { Tx } from './db.js';

export interface TermsRow {
  id: string; agency_id: string; version: number; payment_model: 'payroll_management' | 'one_time_fee'; fee_type: 'percent_of_ctc' | 'fixed';
  fee_value: number; lockin_days: number | null; replacement_days: number | null; effective_from: string; agreement_ref: string | null;
  notes: string | null; is_active: boolean; created_at: Date;
}

/**
 * The commercial terms that applied on a date: the latest version that had taken effect by then, if it
 * is active. A hire stores this version's id, so later changes never rewrite what was agreed at the time.
 */
export async function termsEffectiveOn(tx: Tx, agencyId: string, onDate: string): Promise<TermsRow | null> {
  const row = await tx
    .selectFrom('agency_terms')
    .select(['id', 'agency_id', 'version', 'payment_model', 'fee_type', 'fee_value', 'lockin_days', 'replacement_days', 'effective_from', 'agreement_ref', 'notes', 'is_active', 'created_at'])
    .where('agency_id', '=', agencyId)
    .where('effective_from', '<=', onDate)
    .orderBy('effective_from', 'desc')
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row && row.is_active ? (row as TermsRow) : null;
}

/** Fee for one hire under these terms, from the agreed annual CTC. Null when the terms have no per-hire fee. */
export function feeFor(terms: Pick<TermsRow, 'payment_model' | 'fee_type' | 'fee_value'>, annualCtc: number): number | null {
  if (terms.payment_model === 'payroll_management' && terms.fee_type === 'fixed') return null; // a service fee, not per hire
  return terms.fee_type === 'percent_of_ctc' ? Math.round(((annualCtc * terms.fee_value) / 100) * 100) / 100 : terms.fee_value;
}
