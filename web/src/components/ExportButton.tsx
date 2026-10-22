import { can, type Me } from '../api';
import { downloadCsv } from '../csv';

/** Company admin (HR Lead) and agency admins can export any list, with its current filters. */
export const canExport = (me: Me) => can(me, 'users.manage') || me.roles.some((r) => r.code === 'agency_admin');

export function ExportButton({ name, head, rows, disabled }: { name: string; head: string[]; rows: () => unknown[][]; disabled?: boolean }) {
  return <button className="btn" type="button" disabled={disabled} onClick={() => downloadCsv(name, head, rows())}>Export CSV</button>;
}
