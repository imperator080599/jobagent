import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, ChartColumn, Inbox, LayoutDashboard, LogOut, Mail, Radar, Send, Settings, User } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { Loading } from './components/ui';
import { get, post } from './lib/api';
import { cx } from './lib/format';
import { type SessionUser, useAuthStatus } from './lib/hooks';
import { LoginPage, SetupPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { SettingsPage } from './pages/Settings';
import { ProfilePage } from './pages/Profile';
import { SearchPage } from './pages/Search';
import { JobsPage } from './pages/Jobs';
import { InboxPage } from './pages/Inbox';
import { ApplicationsPage } from './pages/Applications';
import { TrackingPage } from './pages/Tracking';
import { AnalyticsPage } from './pages/Analytics';

const NAV = [
  { href: '/', label: 'Pilotage', icon: LayoutDashboard, mobile: true },
  { href: '/validation', label: 'À valider', icon: Inbox, mobile: true, badge: 'inbox' as const },
  { href: '/offres', label: 'Offres', icon: Briefcase, mobile: true },
  { href: '/candidatures', label: 'Candidatures', icon: Send, mobile: true },
  { href: '/suivi', label: 'Suivi', icon: Mail, mobile: false },
  { href: '/profil', label: 'Profil', icon: User, mobile: true },
  { href: '/recherche', label: 'Recherche', icon: Radar, mobile: false },
  { href: '/analytique', label: 'Analytique', icon: ChartColumn, mobile: false },
  { href: '/parametres', label: 'Paramètres', icon: Settings, mobile: false },
];

function isActive(location: string, href: string) {
  return href === '/' ? location === '/' : location === href || location.startsWith(`${href}/`);
}

function Shell({ user, demo, children }: { user: SessionUser; demo: boolean; children: ReactNode }) {
  const [location] = useLocation();
  const qc = useQueryClient();
  const counts = useQuery({ queryKey: ['overview', 'counts'], queryFn: () => get<{ inbox: number; working: number }>('/overview/counts'), refetchInterval: 20_000 });
  const logout = async () => {
    await post('/auth/logout');
    qc.clear();
    window.location.assign('/');
  };
  return (
    <div className="min-h-dvh lg:pl-60">
      {/* Navigation latérale (ordinateur) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-slate-200 bg-white lg:flex">
        <Link href="/" className="flex items-center gap-2.5 px-5 py-5">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-[17px] font-semibold tracking-tight">JobAgent</span>
        </Link>
        <nav className="flex-1 space-y-0.5 px-3" aria-label="Navigation principale">
          {NAV.map((n) => {
            const active = isActive(location, n.href);
            const badge = n.badge === 'inbox' ? counts.data?.inbox : 0;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors', active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}
              >
                <n.icon className="size-[18px]" aria-hidden />
                <span className="flex-1">{n.label}</span>
                {!!badge && <span className={cx('rounded-full px-1.5 text-[11px] font-semibold', active ? 'bg-white text-slate-900' : 'bg-indigo-600 text-white')}>{badge}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-100 p-3">
          {!!counts.data?.working && (
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-700">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-indigo-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-indigo-600" />
              </span>
              L'agent travaille ({counts.data.working})
            </div>
          )}
          {demo && <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-800">Mode démonstration : l'IA est simulée.</div>}
          <div className="flex items-center gap-2 px-2 py-1">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">{(user.name || user.email).slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-slate-900">{user.name || 'Mon compte'}</p>
              <p className="truncate text-[11px] text-slate-500">{user.email}</p>
            </div>
            <button type="button" onClick={logout} title="Se déconnecter" aria-label="Se déconnecter" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>

      <main className="mx-auto w-full max-w-6xl px-4 pt-5 pb-28 sm:px-6 lg:px-8 lg:pt-8 lg:pb-12">{children}</main>

      {/* Navigation basse (mobile) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Navigation">
        {NAV.filter((n) => n.mobile).map((n) => {
          const active = isActive(location, n.href);
          const badge = n.badge === 'inbox' ? counts.data?.inbox : 0;
          return (
            <Link key={n.href} href={n.href} className={cx('relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium', active ? 'text-slate-900' : 'text-slate-400')}>
              <n.icon className="size-5" aria-hidden />
              {n.label}
              {!!badge && <span className="absolute top-1 left-1/2 ml-2 rounded-full bg-indigo-600 px-1.5 text-[10px] font-semibold text-white">{badge}</span>}
            </Link>
          );
        })}
        <Link href="/parametres" className={cx('flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium', isActive(location, '/parametres') || isActive(location, '/recherche') ? 'text-slate-900' : 'text-slate-400')}>
          <Settings className="size-5" aria-hidden />
          Réglages
        </Link>
      </nav>
    </div>
  );
}

export function App() {
  const status = useAuthStatus();
  const qc = useQueryClient();
  useEffect(() => {
    const h = () => void qc.invalidateQueries({ queryKey: ['auth-status'] });
    window.addEventListener('jobagent:unauthorized', h);
    return () => window.removeEventListener('jobagent:unauthorized', h);
  }, [qc]);

  if (status.isLoading) return <Loading />;
  if (status.isError || !status.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6 text-center text-sm text-slate-600">
        Le serveur ne répond pas. Vérifiez qu'il est démarré, puis rechargez la page.
      </div>
    );
  }
  if (status.data.needsSetup) return <SetupPage status={status.data} />;
  if (!status.data.user) return <LoginPage />;

  return (
    <Shell user={status.data.user} demo={status.data.demo}>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/validation" component={InboxPage} />
        <Route path="/offres/:id?" component={JobsPage} />
        <Route path="/candidatures" component={ApplicationsPage} />
        <Route path="/suivi/:tab?" component={TrackingPage} />
        <Route path="/profil/:tab?" component={ProfilePage} />
        <Route path="/recherche/:tab?" component={SearchPage} />
        <Route path="/analytique" component={AnalyticsPage} />
        <Route path="/parametres/:tab?" component={SettingsPage} />
        <Route>
          <Redirect to="/" />
        </Route>
      </Switch>
    </Shell>
  );
}
