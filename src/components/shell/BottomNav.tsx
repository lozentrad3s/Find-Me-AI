"use client";

/**
 * The five-tab shell from the design reference, with the voice control raised
 * in the centre.
 *
 * Five tabs is the practical ceiling for a bottom bar — beyond that the targets
 * get too narrow to hit reliably on a phone — and it matches the master
 * document's five core tabs exactly.
 *
 * Voice sits in the middle and lifted, rather than being a sixth tab, because
 * it is not a destination. It is the primary way to use the product; the tabs
 * are the fallback for when you would rather tap than talk.
 */

import { Compass, Home, Mic, Route, Shield, User } from "lucide-react";

import styles from "./BottomNav.module.css";

export type TabId = "home" | "explore" | "trips" | "safety" | "profile";

export interface BottomNavProps {
  active: TabId;
  onChange: (tab: TabId) => void;
  onVoice: () => void;
  listening: boolean;
}

const LEFT_TABS: Array<{ id: TabId; label: string; Icon: typeof Home }> = [
  { id: "home", label: "Home", Icon: Home },
  { id: "explore", label: "Explore", Icon: Compass },
];

const RIGHT_TABS: Array<{ id: TabId; label: string; Icon: typeof Home }> = [
  { id: "trips", label: "Trips", Icon: Route },
  { id: "profile", label: "Profile", Icon: User },
];

export default function BottomNav({
  active,
  onChange,
  onVoice,
  listening,
}: BottomNavProps) {
  return (
    <nav className={styles.nav} aria-label="Main">
      {LEFT_TABS.map((tab) => (
        <Tab key={tab.id} tab={tab} active={active} onChange={onChange} />
      ))}

      <span className={styles.voiceSlot}>
        <button
          type="button"
          className={styles.voice}
          data-listening={listening}
          onClick={onVoice}
          title="Talk to Find Me"
        >
          <Mic size={24} strokeWidth={2.2} />
          <span className="sr-only">Talk to Find Me</span>
        </button>
      </span>

      {RIGHT_TABS.map((tab) => (
        <Tab key={tab.id} tab={tab} active={active} onChange={onChange} />
      ))}
    </nav>
  );
}

function Tab({
  tab,
  active,
  onChange,
}: {
  tab: { id: TabId; label: string; Icon: typeof Home };
  active: TabId;
  onChange: (tab: TabId) => void;
}) {
  const isActive = active === tab.id;
  const Icon = tab.Icon;

  return (
    <button
      type="button"
      className={styles.tab}
      data-active={isActive}
      onClick={() => onChange(tab.id)}
      aria-current={isActive ? "page" : undefined}
    >
      <Icon size={20} strokeWidth={isActive ? 2.3 : 1.9} aria-hidden="true" />
      <span className={styles.tabLabel}>{tab.label}</span>
      <span className={styles.tabDot} aria-hidden="true" />
    </button>
  );
}

/** Exported so the shell can render a Safety entry point elsewhere. */
export const SAFETY_TAB: { id: TabId; label: string; Icon: typeof Home } = {
  id: "safety",
  label: "Safety",
  Icon: Shield,
};
