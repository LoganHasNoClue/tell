export type Mode = "fed" | "debate";

export interface Driver {
  quote: string;
  effect: number; // signed
  why: string;
}

export interface SubSignals {
  hawk_dove: number | null; // -1 dovish .. +1 hawkish  (Fed)
  hedging: number | null; //   0 committal .. 1 evasive (Fed) | dodge (Debate)
  momentum: number | null; // -1 .. +1                  (Debate)
}

export interface ScoreUpdate {
  t: number;
  our_prob: number;
  delta: number;
  drivers: Driver[];
  subsignals: SubSignals;
}

export interface ScenarioConfig {
  id: string;
  mode: Mode;
  title: string;
  subtitle: string;
  tag: string;
  video: string;
  outcome_label: string;
  hero_label: string;
  rubric_id: string;
  duration: number;
  market_csv: string;
  precomputed_run: string;
  captions: string;
  submeters: string[];
  lead_time_s: number | null;
  lead_level: number;
  source_label: string;
  model_label: string;
  /** scenario time at which the video (and TELL's read) begins; market shows before it */
  video_offset?: number;
  market_placeholder?: boolean;
  scored_live?: boolean;
}

export interface IndexEntry {
  id: string;
  mode: Mode;
  title: string;
  subtitle: string;
  tag: string;
  outcome_label: string;
  hero_label: string;
  duration: number;
  lead_time_s: number | null;
}

export interface Caption {
  t: number;
  speaker: string;
  text: string;
}

/** The single frame pushed to the UI each tick (matches backend StateFrame). */
export interface StateFrame {
  t: number;
  our_prob: number;
  market_prob: number;
  lead: number; // our_prob - market_prob
  diverging: boolean;
  delta: number;
  drivers: Driver[];
  subsignals: SubSignals;
  outcome_label: string;
}

/** An entry in the WHY feed (a receipt). */
export interface WhyEntry {
  id: number;
  t: number;
  quote: string;
  effect: number;
  why: string;
}
