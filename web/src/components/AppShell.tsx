import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { api, can, isRecruiter, type Me } from '../api';
import { meQuery, unreadCountQuery } from '../queries';

interface NavItem {
  to: '/' | '/departments' | '/users' | '/requisitions' | '/vacancies' | '/candidates' | '/pipeline' | '/agencies' | '/portal' | '/portal/submissions' | '/interviews' | '/my-interviews' | '/reports' | '/offers' | '/decisions' | '/sourcing' | '/status' | '/employees' | '/leaderboards' | '/terms' | '/team' | '/salary-joining' | '/setup';
  label: string;
  icon: IconName;
  visible: (me: Me) => boolean;
}

/** Hiring managers decide and interview; they work from Decisions and Interviews, not the candidate database. */
const decidesOnly = (me: Me) => can(me, 'decisions.record') && !can(me, 'applications.manage');

// Plain-language names, grouped by what people are trying to do. Each item is shown only if the person's role allows it.
// The four roles each get their own short menu.
const HR_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'home', visible: () => true },
  { to: '/vacancies', label: 'Jobs', icon: 'jobs', visible: () => true },
  { to: '/candidates', label: 'Candidates', icon: 'people', visible: () => true },
  { to: '/interviews', label: 'Interviews', icon: 'calendar', visible: () => true },
  { to: '/agencies', label: 'Agencies', icon: 'agency', visible: () => true },
  { to: '/salary-joining', label: 'Salary & joining', icon: 'offer', visible: () => true },
  { to: '/employees', label: 'Employees', icon: 'check', visible: () => true },
  { to: '/leaderboards', label: 'Leaderboards', icon: 'trophy', visible: () => true },
  { to: '/reports', label: 'Reports', icon: 'chart', visible: () => true },
  { to: '/departments', label: 'Departments', icon: 'org', visible: (me) => can(me, 'departments.manage') || can(me, 'vacancies.view_all') },
  { to: '/users', label: 'Team & roles', icon: 'shield', visible: () => true },
  { to: '/setup', label: 'Company setup', icon: 'plus', visible: () => true },
];
const AGENCY_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'home', visible: () => true },
  { to: '/portal', label: 'Open jobs', icon: 'jobs', visible: () => true },
  { to: '/portal/submissions', label: 'My submissions', icon: 'people', visible: () => true },
  { to: '/terms', label: 'Commercial terms', icon: 'offer', visible: (me) => me.roles.some((r) => r.code === 'agency_admin') },
  { to: '/team', label: 'My team', icon: 'shield', visible: (me) => me.roles.some((r) => r.code === 'agency_admin') },
];
const INTERVIEWER_NAV: NavItem[] = [
  { to: '/my-interviews', label: 'My interviews', icon: 'chat', visible: () => true },
  { to: '/salary-joining', label: 'Salary & joining', icon: 'offer', visible: () => true },
  { to: '/employees', label: 'My department staff', icon: 'check', visible: (me) => !!me.head_of_departments?.length },
];

const RECRUITER_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'home', visible: () => true },
  { to: '/vacancies', label: 'Jobs', icon: 'jobs', visible: () => true },
  { to: '/sourcing', label: 'Sourcing', icon: 'plus', visible: () => true },
  { to: '/status', label: 'Candidate status', icon: 'check', visible: () => true },
  { to: '/salary-joining', label: 'Salary & joining', icon: 'offer', visible: () => true },
  { to: '/employees', label: 'My department staff', icon: 'check', visible: (me) => !!me.head_of_departments?.length },
];

const NAV: { section?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Home', icon: 'home', visible: (me) => !can(me, 'agency_portal.use') }] },
  {
    section: 'Your work',
    items: [
      { to: '/portal', label: 'Open jobs', icon: 'jobs', visible: (me) => can(me, 'agency_portal.use') },
      { to: '/portal/submissions', label: 'My submissions', icon: 'people', visible: (me) => can(me, 'agency_portal.use') },
    ],
  },
  {
    section: 'Hiring',
    items: [
      { to: '/requisitions', label: 'Hiring requests', icon: 'request', visible: (me) => can(me, 'requisitions.create') || can(me, 'requisitions.approve') || can(me, 'vacancies.view_all') || can(me, 'vacancies.manage') },
      { to: '/vacancies', label: 'Jobs', icon: 'jobs', visible: (me) => can(me, 'vacancies.view_all') || can(me, 'vacancies.view_assigned') },
      { to: '/candidates', label: 'Candidates', icon: 'people', visible: (me) => can(me, 'candidates.view') && !decidesOnly(me) },
      { to: '/decisions', label: 'Decisions', icon: 'check', visible: (me) => decidesOnly(me) },
      { to: '/pipeline', label: 'Candidate board', icon: 'board', visible: (me) => can(me, 'applications.manage') },
      { to: '/interviews', label: 'Interviews', icon: 'calendar', visible: (me) => can(me, 'interviews.manage') || can(me, 'feedback.view') || can(me, 'decisions.record') },
      { to: '/offers', label: 'Offers', icon: 'offer', visible: (me) => can(me, 'offers.manage') || can(me, 'offers.approve') },
      { to: '/agencies', label: 'Agencies', icon: 'agency', visible: (me) => can(me, 'agencies.manage') },
    ],
  },
  { section: 'Insights', items: [{ to: '/reports', label: 'Reports', icon: 'chart', visible: (me) => can(me, 'analytics.view') }] },
  { section: 'Interviewing', items: [{ to: '/my-interviews', label: 'My interviews', icon: 'chat', visible: (me) => !can(me, 'agency_portal.use') }] },
  {
    section: 'Company',
    items: [
      { to: '/departments', label: 'Departments', icon: 'org', visible: (me) => can(me, 'departments.manage') || can(me, 'vacancies.view_all') },
      { to: '/users', label: 'Team & roles', icon: 'shield', visible: (me) => can(me, 'users.manage') },
    ],
  },
];

function menuFor(me: Me): { section?: string; items: NavItem[] }[] {
  if (can(me, 'agency_portal.use')) return [{ items: AGENCY_NAV }];
  if (can(me, 'employment.manage')) return [{ items: HR_NAV }];
  if (isRecruiter(me)) return [{ items: RECRUITER_NAV }];
  if (Object.keys(me.permissions).length === 0) return [{ items: INTERVIEWER_NAV }];
  return NAV; // earlier roles that already exist keep their menu
}

export function useMe(): Me {
  return useSuspenseQuery(meQuery).data;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export function AppShell() {
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const unread = useQuery(unreadCountQuery);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const path = useRouterState({ select: (r) => r.location.pathname });
  const logout = useMutation({
    mutationFn: () => api('POST', '/auth/logout'),
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: '/login', search: { redirect: undefined } });
    },
  });
  // Close the drawer after navigating, and the user menu on any outside click or Escape.
  useEffect(() => setDrawer(false), [path]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menu]);
  const roleNames = me.roles.map((r) => r.name).join(', ') || 'No role';

  return (
    <div className="shell" data-drawer={drawer}>
      <a className="skip-link" href="#main">Skip to content</a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><span className="brand-mark">R</span><span>RMS</span>
          <button className="icon-btn drawer-close" aria-label="Close menu" onClick={() => setDrawer(false)}><Icon name="close" /></button>
        </div>
        {menuFor(me).map((group, i) => {
          const items = group.items.filter((item) => item.visible(me));
          if (items.length === 0) return null;
          return (
            <div key={i} className="nav-group">
              {group.section && <div className="nav-section">{group.section}</div>}
              {items.map((item) => (
                <Link key={item.to} to={item.to} className="nav-link" activeOptions={{ exact: item.to === '/' }}>
                  <Icon name={item.icon} />{item.label}
                </Link>
              ))}
            </div>
          );
        })}
        <div className="sidebar-foot"><span className="company-dot" aria-hidden>{me.tenant.name[0]}</span><div><strong>{me.tenant.name}</strong></div></div>
      </nav>
      <div className="scrim" onClick={() => setDrawer(false)} aria-hidden />
      <header className="topbar">
        <button className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setDrawer(true)}><Icon name="menu" size={20} /></button>
        <span className="tenant-name">{me.tenant.name}</span>
        <div className="profile">
          <Link to="/notifications" className="icon-btn bell" aria-label={`Notifications${unread.data ? `, ${unread.data} unread` : ''}`}>
            <Icon name="bell" size={20} />{unread.data ? <span className="bell-count">{unread.data > 99 ? '99+' : unread.data}</span> : null}
          </Link>
          <div className="user-menu" ref={menuRef}>
            <button className="user-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              <span className="avatar" aria-hidden>{initials(me.user.full_name)}</span>
              <span className="who"><strong>{me.user.full_name}</strong><small>{roleNames}</small></span>
              <Icon name="chevron" size={16} />
            </button>
            {menu && (
              <div className="menu-pop" role="menu">
                <div className="menu-head"><strong>{me.user.full_name}</strong><span>{me.user.email}</span><span>{roleNames}</span></div>
                <Link role="menuitem" to="/account" className="menu-item" onClick={() => setMenu(false)}><Icon name="shield" />Account &amp; password</Link>
                <button role="menuitem" className="menu-item" onClick={() => logout.mutate()} disabled={logout.isPending}><Icon name="logout" />Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="main" id="main">
        <div className="page"><Outlet /></div>
      </main>
    </div>
  );
}
