'use client';

import { useEffect } from 'react';
import { bridge } from '@/lib/bridge';
import { useHelm, type TabKey } from '@/lib/store';
import { Banners, TopBar } from '@/components/TopBar';
import { ProjectTree } from '@/components/ProjectTree';
import { RightRail } from '@/components/RightRail';
import { MissionTab } from '@/components/MissionTab';
import { GateTab } from '@/components/GateTab';
import { LaunchPadTab } from '@/components/LaunchPadTab';
import { StandupTab } from '@/components/StandupTab';
import { SettingsTab } from '@/components/SettingsTab';
import { LoopsTab } from '@/components/LoopsTab';
import { CommandPalette } from '@/components/CommandPalette';
import { AddProjectModal, RecruitModal } from '@/components/Modals';
import { TranscriptDrawer } from '@/components/TranscriptDrawer';

const TABS: Array<[TabKey, string]> = [
  ['mission', 'mission'],
  ['launch', 'launch pad'],
  ['gate', 'gate'],
  ['loops', 'loops'],
  ['standup', 'standup'],
  ['settings', 'settings'],
];

export default function Cockpit() {
  const connect = useHelm((s) => s.connect);
  const tab = useHelm((s) => s.tab);
  const setTab = useHelm((s) => s.setTab);
  const setPalette = useHelm((s) => s.setPalette);
  const closeAll = useHelm((s) => s.closeAll);
  const seedEvents = useHelm((s) => s.seedEvents);
  const seedGate = useHelm((s) => s.seedGate);
  const pending = useHelm((s) => s.gate.filter((g) => g.status === 'pending').length);

  useEffect(() => {
    connect();
    bridge
      .events(50)
      .then((r) => seedEvents(r.events))
      .catch(() => {});
    bridge
      .gate()
      .then((r) => seedGate(r.items))
      .catch(() => {});
  }, [connect, seedEvents, seedGate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      // Law 3 asks for a hotkey, not just a button. Shift makes it hard to hit
      // by accident, and it works from anywhere including inside a text field.
      if (meta && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        void bridge.kill('hotkey');
      } else if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === 'Escape') {
        closeAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette, closeAll]);

  return (
    <div className="shell">
      <TopBar />
      <div className="panes">
        <ProjectTree />

        <div className="pane" style={{ borderRight: 'none' }}>
          <Banners />
          <div className="tabs" role="tablist">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                className="tab"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
                {key === 'gate' && pending > 0 ? ` (${pending})` : ''}
              </button>
            ))}
          </div>
          <div className="slide-up" key={tab}>
            {tab === 'mission' && <MissionTab />}
            {tab === 'launch' && <LaunchPadTab />}
            {tab === 'gate' && <GateTab />}
            {tab === 'loops' && <LoopsTab />}
            {tab === 'standup' && <StandupTab />}
            {tab === 'settings' && <SettingsTab />}
          </div>
        </div>

        <RightRail />
      </div>

      <CommandPalette />
      <AddProjectModal />
      <RecruitModal />
      <TranscriptDrawer />
    </div>
  );
}
