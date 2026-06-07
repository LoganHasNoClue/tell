import type { ScenarioConfig, ScoreUpdate, Caption, IndexEntry } from "./types";

export async function loadIndex(): Promise<IndexEntry[]> {
  const res = await fetch("/scenarios/index.json", { cache: "no-store" });
  return res.json();
}

export interface LoadedScenario {
  config: ScenarioConfig;
  run: ScoreUpdate[];
  market: { t: number; p: number }[];
  captions: Caption[];
}

function parseMarketCsv(text: string): { t: number; p: number }[] {
  const lines = text.trim().split(/\r?\n/);
  const out: { t: number; p: number }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [t, p] = lines[i].split(",");
    if (t === undefined || p === undefined) continue;
    out.push({ t: parseFloat(t), p: parseFloat(p) });
  }
  return out;
}

export async function loadScenario(id: string): Promise<LoadedScenario> {
  const config: ScenarioConfig = await fetch(`/scenarios/${id}/scenario.json`, {
    cache: "no-store",
  }).then((r) => r.json());

  const [run, marketText, captions] = await Promise.all([
    fetch(config.precomputed_run, { cache: "no-store" }).then((r) => r.json()),
    fetch(config.market_csv, { cache: "no-store" }).then((r) => r.text()),
    fetch(config.captions, { cache: "no-store" }).then((r) => r.json()),
  ]);

  return {
    config,
    run: run as ScoreUpdate[],
    market: parseMarketCsv(marketText),
    captions: captions as Caption[],
  };
}
