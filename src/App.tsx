import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Prototyp webowej aplikacji do:
 * - wgrywania plikow SVG (np. eksport z LightBurn)
 * - skalowania i ustawiania ilosci projektow
 * - prostego nestingu (heurystyka: shelf/row packing) na arkuszu
 * - wyliczania ceny kazdego projektu osobno (material + energia + amortyzacja + robocizna)
 * - eksportu ulozenia do SVG (do ponownego otwarcia w LightBurn)
 *
 * Uwaga: To jest MVP. Prawdziwy nesting (z obrotami, dowolnymi ksztaltami, marginesami od sciezek)
 * wymaga bardziej zaawansowanego algorytmu (np. no-fit polygon). Tutaj jest stabilny start.
 */

// ------------------------- Helpers -------------------------

function mmToPx(mm: number, scale: number) {
  return mm * scale;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

// Bardzo uproszczony odczyt rozmiaru SVG: viewBox > width/height.
function parseSvgSize(svgText: string): { w: number; h: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return { w: 100, h: 100 };

  const vb = svg.getAttribute("viewBox");
  if (vb) {
    const parts = vb
      .split(/[ ,]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return { w: parts[2], h: parts[3] };
    }
  }

  const wAttr = svg.getAttribute("width");
  const hAttr = svg.getAttribute("height");
  const w = wAttr ? parseFloat(wAttr) : NaN;
  const h = hAttr ? parseFloat(hAttr) : NaN;
  if (Number.isFinite(w) && Number.isFinite(h)) return { w, h };

  return { w: 100, h: 100 };
}

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

// Prosty shelf packing: sortuj malejaco po wysokosci, ukladaj w rzedach.
// Zwraca pozycje (x,y) dla kazdego prostokata.
function shelfPack(
  items: { id: string; w: number; h: number; pad: number }[],
  binW: number,
  binH: number
): { ok: boolean; placed: Record<string, { x: number; y: number }> } {
  const placed: Record<string, { x: number; y: number }> = {};
  const sorted = [...items].sort((a, b) => b.h - a.h);

  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;

  for (const it of sorted) {
    const W = it.w + it.pad * 2;
    const H = it.h + it.pad * 2;

    if (W > binW || H > binH) return { ok: false, placed: {} };

    if (cursorX + W > binW) {
      // nowy rzad
      cursorX = 0;
      cursorY += rowH;
      rowH = 0;
    }

    if (cursorY + H > binH) return { ok: false, placed: {} };

    placed[it.id] = { x: cursorX + it.pad, y: cursorY + it.pad };
    cursorX += W;
    rowH = Math.max(rowH, H);
  }

  return { ok: true, placed };
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ------------------------- Types -------------------------

type Design = {
  id: string;
  name: string;
  svgText: string;
  baseW: number; // jednostki z SVG (zwykle px), przyjmujemy jako mm po imporcie (konfigurowalne przez scale)
  baseH: number;
  scale: number; // 1.0 = baza
  qty: number;
  // szacunek czasu w minutach (opcjonalnie) — jesli brak, liczymy z "czas na sztuke" globalnie
  minutesOverride?: number;
};

type Placed = {
  instanceId: string;
  designId: string;
  name: string;
  w: number;
  h: number;
  x: number;
  y: number;
};

// ------------------------- App -------------------------

export default function App() {
  // Arkusz
  const [sheetW, setSheetW] = useState(600); // mm
  const [sheetH, setSheetH] = useState(400); // mm
  const [kerf, setKerf] = useState(0.15); // mm (informacyjnie / przyszlosciowo)
  const [padding, setPadding] = useState(2); // mm odstep miedzy projektami

  // Koszty
  const [sheetCost, setSheetCost] = useState(18); // PLN / arkusz
  const [powerPrice, setPowerPrice] = useState(1.2); // PLN / kWh
  const [deprPerHour, setDeprPerHour] = useState(12); // PLN / h
  const [laborPerHour, setLaborPerHour] = useState(45); // PLN / h

  // Maszyna (uproczony model czasu/energii)
  const [laserWatt, setLaserWatt] = useState(60); // W
  const [assistWatt, setAssistWatt] = useState(20); // W (np. wyciag/air assist — uproszczenie)
  const [baseMinutesPerItem, setBaseMinutesPerItem] = useState(3); // min / szt (jesli nie podasz override)
  const [setupMinutes, setSetupMinutes] = useState(6); // min na uruchomienie, mocowanie, itp. (dzielone na zamowienie)

  // Projekty
  const [designs, setDesigns] = useState<Design[]>([]);

  // Skala podgladu
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewScale, setViewScale] = useState(1.0);

  // Zbuduj liste instancji do nestingu
  const instances = useMemo(() => {
    const out: { instanceId: string; designId: string; name: string; w: number; h: number }[] = [];
    for (const d of designs) {
      const w = d.baseW * d.scale;
      const h = d.baseH * d.scale;
      for (let i = 0; i < d.qty; i++) {
        out.push({ instanceId: `${d.id}__${i + 1}`, designId: d.id, name: d.name, w, h });
      }
    }
    return out;
  }, [designs]);

  // NEST
  const nesting = useMemo(() => {
    const items = instances.map((it) => ({ id: it.instanceId, w: it.w, h: it.h, pad: padding }));
    const packed = shelfPack(items, sheetW, sheetH);
    if (!packed.ok) return { ok: false as const, placed: [] as Placed[] };

    const placed: Placed[] = instances.map((it) => {
      const p = packed.placed[it.instanceId];
      return { ...it, x: p.x, y: p.y };
    });

    return { ok: true as const, placed };
  }, [instances, padding, sheetW, sheetH]);

  // Rysuj arkusz i polozenia
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    // dopasuj skale widoku
    const maxW = 1000;
    const maxH = 520;
    const s = Math.min(maxW / sheetW, maxH / sheetH) * viewScale;

    c.width = Math.floor(sheetW * s);
    c.height = Math.floor(sheetH * s);

    ctx.clearRect(0, 0, c.width, c.height);

    // ramka arkusza
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, c.width - 2, c.height - 2);

    // siatka co 50mm
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    for (let x = 50; x < sheetW; x += 50) {
      ctx.beginPath();
      ctx.moveTo(mmToPx(x, s), 0);
      ctx.lineTo(mmToPx(x, s), c.height);
      ctx.stroke();
    }
    for (let y = 50; y < sheetH; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, mmToPx(y, s));
      ctx.lineTo(c.width, mmToPx(y, s));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (!nesting.ok) {
      ctx.font = "16px sans-serif";
      ctx.fillText("Nie miesci sie na arkuszu — zmniejsz skale/ilosc albo zwieksz arkusz.", 10, 24);
      return;
    }

    // prostokaty instancji
    ctx.lineWidth = 2;
    ctx.font = "12px sans-serif";

    nesting.placed.forEach((p) => {
      const x = mmToPx(p.x, s);
      const y = mmToPx(p.y, s);
      const w = mmToPx(p.w, s);
      const h = mmToPx(p.h, s);
      ctx.strokeRect(x, y, w, h);
      ctx.fillText(p.instanceId, x + 4, y + 14);
    });
  }, [nesting, sheetW, sheetH, viewScale]);

  // ------------------------- Koszty -------------------------

  const totalArea = useMemo(() => {
    // Pole zajete przez bounding boxy (nie realny odpad)
    return instances.reduce((acc, it) => acc + it.w * it.h, 0); // mm2
  }, [instances]);

  const sheetArea = sheetW * sheetH; // mm2
  const materialShare = useMemo(() => {
    if (!nesting.ok || instances.length === 0) return 0;
    // Udzial materialu liczony proporcjonalnie do pola bbox
    return sheetCost / Math.max(1e-9, sheetArea);
  }, [nesting.ok, instances.length, sheetCost, sheetArea]); // PLN / mm2

  const timeAndEnergyTotals = useMemo(() => {
    // Czas: suma minut z override albo bazowych + setup
    let minutes = setupMinutes;
    for (const it of instances) {
      const d = designs.find((x) => x.id === it.designId);
      const m = d?.minutesOverride ?? baseMinutesPerItem;
      minutes += m;
    }

    const hours = minutes / 60;

    // Energia: (laserWatt + assistWatt) * czas
    const kwh = ((laserWatt + assistWatt) / 1000) * hours;

    return { minutes, hours, kwh };
  }, [instances, designs, baseMinutesPerItem, setupMinutes, laserWatt, assistWatt]);

  const orderCosts = useMemo(() => {
    const energy = timeAndEnergyTotals.kwh * powerPrice;
    const depr = timeAndEnergyTotals.hours * deprPerHour;
    const labor = timeAndEnergyTotals.hours * laborPerHour;
    return { energy, depr, labor, total: energy + depr + labor };
  }, [timeAndEnergyTotals, powerPrice, deprPerHour, laborPerHour]);

  const perItemPrice = useMemo(() => {
    // Cena per instancja: material proporcjonalny do pola bbox + podzial kosztow czasu
    // Koszty czasu dzielimy proporcjonalnie do "minut" (override lub base)
    if (instances.length === 0) return new Map<string, number>();

    const minutesByInstance = new Map<string, number>();
    let sumM = 0;
    for (const it of instances) {
      const d = designs.find((x) => x.id === it.designId);
      const m = d?.minutesOverride ?? baseMinutesPerItem;
      minutesByInstance.set(it.instanceId, m);
      sumM += m;
    }

    const timeCostPool = orderCosts.total; // energy+depr+labor

    const out = new Map<string, number>();
    for (const it of instances) {
      const mat = it.w * it.h * materialShare;
      const m = minutesByInstance.get(it.instanceId) ?? baseMinutesPerItem;
      const timePart = sumM > 0 ? (m / sumM) * timeCostPool : timeCostPool / instances.length;
      out.set(it.instanceId, mat + timePart);
    }
    return out;
  }, [instances, designs, baseMinutesPerItem, materialShare, orderCosts.total]);

  const groupedPrices = useMemo(() => {
    // Cena "projektu" (design) osobno: srednia cena instancji w grupie
    const byDesign = new Map<string, { name: string; count: number; sum: number }>();
    for (const it of instances) {
      const price = perItemPrice.get(it.instanceId) ?? 0;
      const cur = byDesign.get(it.designId) ?? { name: it.name, count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += price;
      byDesign.set(it.designId, cur);
    }
    return Array.from(byDesign.entries()).map(([designId, v]) => ({
      designId,
      name: v.name,
      qty: v.count,
      unit: v.count ? v.sum / v.count : 0,
      total: v.sum,
    }));
  }, [instances, perItemPrice]);

  // ------------------------- Import / Export -------------------------

  async function onAddSvg(files: FileList | null) {
    if (!files || files.length === 0) return;

    const next: Design[] = [];
    for (const f of Array.from(files)) {
      const text = await f.text();
      const { w, h } = parseSvgSize(text);
      next.push({
        id: makeId(),
        name: f.name.replace(/\.[^.]+$/, ""),
        svgText: text,
        baseW: w,
        baseH: h,
        scale: 1,
        qty: 1,
      });
    }

    setDesigns((prev) => [...prev, ...next]);
  }

  function removeDesign(id: string) {
    setDesigns((prev) => prev.filter((d) => d.id !== id));
  }

  function updateDesign(id: string, patch: Partial<Design>) {
    setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  function exportLayoutSvg() {
    if (!nesting.ok) return;

    // Minimalny eksport: prostokaty bbox + osadzone svgi jako <g> z transform.
    // W praktyce: LightBurn czesto akceptuje proste SVG z grupami.
    // Uwaga: tu zakladamy, ze jednostki SVG == mm (to moze wymagac dopracowania w Twoim workflow).

    const header = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    const svgOpen = `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${sheetW}mm\" height=\"${sheetH}mm\" viewBox=\"0 0 ${sheetW} ${sheetH}\">\n`;
    const svgClose = `</svg>\n`;

    const body: string[] = [];
    body.push(`<rect x=\"0\" y=\"0\" width=\"${sheetW}\" height=\"${sheetH}\" fill=\"none\" stroke=\"black\" stroke-width=\"0.2\"/>`);

    // Wstaw kazda instancje jako <g> z translate+scale i wklej zawartosc SVG bez zewnetrznego <svg>
    for (const p of nesting.placed) {
      const d = designs.find((x) => x.id === p.designId);
      if (!d) continue;

      // Wytnij wewnetrzny content z SVG
      const inner = d.svgText
        .replace(/^[\s\S]*?<svg[^>]*>/i, "")
        .replace(/<\/svg>[\s\S]*$/i, "");

      // Skala: d.scale, Pozycja: p.x,p.y
      body.push(
        `<g transform=\"translate(${p.x} ${p.y}) scale(${d.scale})\">${inner}</g>`
      );
    }

    const out = header + svgOpen + body.join("\n") + "\n" + svgClose;
    downloadText("layout_export.svg", out);
  }

  // ------------------------- UI -------------------------

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold">Kalkulator wyceny + nesting (CO2 / sklejka)</h1>
            <p className="text-sm text-zinc-600 mt-1">
              Importuj SVG, ustaw skale i ilosci, a aplikacja ulozy projekty na arkuszu i policzy cene kazdego projektu.
            </p>
          </div>

          <div className="flex gap-2">
            <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white shadow-sm border border-zinc-200 cursor-pointer">
              <input
                type="file"
                accept="image/svg+xml"
                multiple
                className="hidden"
                onChange={(e) => onAddSvg(e.target.files)}
              />
              <span className="text-sm font-medium">Wgraj SVG</span>
            </label>

            <button
              className="px-3 py-2 rounded-xl bg-white shadow-sm border border-zinc-200 text-sm font-medium disabled:opacity-50"
              disabled={!nesting.ok}
              onClick={exportLayoutSvg}
              title={!nesting.ok ? "Najpierw dopasuj tak, aby zmiescilo sie na arkuszu" : "Eksport SVG do LightBurn"}
            >
              Eksport ulozenia
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-6">
          {/* Left: settings */}
          <div className="lg:col-span-1 flex flex-col gap-4">
            <Card title="Parametry arkusza">
              <Row label="Szerokosc arkusza (mm)">
                <NumberInput value={sheetW} onChange={setSheetW} min={1} />
              </Row>
              <Row label="Wysokosc arkusza (mm)">
                <NumberInput value={sheetH} onChange={setSheetH} min={1} />
              </Row>
              <Row label="Odstep miedzy projektami (mm)">
                <NumberInput value={padding} onChange={setPadding} min={0} step={0.5} />
              </Row>
              <Row label="Kerf (mm) (informacyjnie)">
                <NumberInput value={kerf} onChange={setKerf} min={0} step={0.01} />
              </Row>
              <Row label="Zoom podgladu">
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={viewScale}
                    onChange={(e) => setViewScale(Number(e.target.value))}
                    className="w-full"
                  />
                  <span className="text-sm tabular-nums w-12 text-right">{viewScale.toFixed(1)}x</span>
                </div>
              </Row>
            </Card>

            <Card title="Koszty (PLN)">
              <Row label="Cena arkusza">
                <NumberInput value={sheetCost} onChange={setSheetCost} min={0} step={0.1} />
              </Row>
              <Row label="Cena pradu (PLN/kWh)">
                <NumberInput value={powerPrice} onChange={setPowerPrice} min={0} step={0.01} />
              </Row>
              <Row label="Amortyzacja (PLN/h)">
                <NumberInput value={deprPerHour} onChange={setDeprPerHour} min={0} step={0.1} />
              </Row>
              <Row label="Godzina pracy (PLN/h)">
                <NumberInput value={laborPerHour} onChange={setLaborPerHour} min={0} step={0.1} />
              </Row>
            </Card>

            <Card title="Model czasu i energii (uproczony)">
              <Row label="Laser (W)">
                <NumberInput value={laserWatt} onChange={setLaserWatt} min={0} step={1} />
              </Row>
              <Row label="Dodatkowe odbiorniki (W)">
                <NumberInput value={assistWatt} onChange={setAssistWatt} min={0} step={1} />
              </Row>
              <Row label="Setup na zamowienie (min)">
                <NumberInput value={setupMinutes} onChange={setSetupMinutes} min={0} step={1} />
              </Row>
              <Row label="Czas na sztuke (min) (domyslnie)">
                <NumberInput value={baseMinutesPerItem} onChange={setBaseMinutesPerItem} min={0} step={0.5} />
              </Row>
              <p className="text-xs text-zinc-600 mt-2">
                Jesli chcesz wiecej dokladnosci: w kolejnym kroku dodamy wyliczanie czasu z dlugosci sciezek (z SVG/DXF)
                oraz predkosci cięcia/jałowego przejazdu z profilu LightBurn.
              </p>
            </Card>
          </div>

          {/* Middle: canvas */}
          <div className="lg:col-span-2 flex flex-col gap-4">
            <Card title="Ulozenie na arkuszu">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-zinc-700">
                  {nesting.ok ? (
                    <span>
                      Instancje: <b>{instances.length}</b> • Zajete bbox: <b>{(totalArea / 1e6).toFixed(3)} m²</b> •
                      Arkusz: <b>{(sheetArea / 1e6).toFixed(3)} m²</b>
                    </span>
                  ) : (
                    <span className="text-rose-700">
                      Nie miesci sie na arkuszu — zmniejsz skale/ilosci lub zwieksz arkusz.
                    </span>
                  )}
                </div>
                <div className="text-sm text-zinc-700 tabular-nums">
                  Szac. czas: <b>{timeAndEnergyTotals.minutes.toFixed(0)} min</b> • Energia: <b>{timeAndEnergyTotals.kwh.toFixed(2)} kWh</b>
                </div>
              </div>

              <div className="mt-3 overflow-auto rounded-xl border border-zinc-200 bg-white">
                <canvas ref={canvasRef} />
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                <Stat label="Energia" value={`${orderCosts.energy.toFixed(2)} PLN`} />
                <Stat label="Amortyzacja" value={`${orderCosts.depr.toFixed(2)} PLN`} />
                <Stat label="Robocizna" value={`${orderCosts.labor.toFixed(2)} PLN`} />
                <Stat label="Razem (czas+energia)" value={`${orderCosts.total.toFixed(2)} PLN`} />
              </div>
              <p className="text-xs text-zinc-600 mt-2">
                Material jest rozbijany proporcjonalnie do pola prostokata otaczajacego (bbox). To MVP. Docelowo mozemy liczyc pole
                rzeczywiste (po poligonach) oraz doliczyc odpad i marginesy.
              </p>
            </Card>

            <Card title="Projekty (skala, ilosc, czas)">
              {designs.length === 0 ? (
                <div className="text-sm text-zinc-600">
                  Wgraj jeden lub kilka plikow SVG (np. eksport z LightBurn). Najlepiej, gdy SVG ma poprawny viewBox.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {designs.map((d) => {
                    const w = d.baseW * d.scale;
                    const h = d.baseH * d.scale;
                    return (
                      <div key={d.id} className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-medium">{d.name}</div>
                            <div className="text-xs text-zinc-600 tabular-nums">
                              Rozmiar: {w.toFixed(1)} × {h.toFixed(1)} (jednostki importu) • baza: {d.baseW.toFixed(1)} × {d.baseH.toFixed(1)}
                            </div>
                          </div>
                          <button
                            className="text-sm px-3 py-1.5 rounded-xl border border-zinc-200 hover:bg-zinc-50"
                            onClick={() => removeDesign(d.id)}
                          >
                            Usun
                          </button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                          <Labeled label="Skala">
                            <div className="flex items-center gap-2">
                              <input
                                type="range"
                                min={0.1}
                                max={3}
                                step={0.05}
                                value={d.scale}
                                onChange={(e) => updateDesign(d.id, { scale: clamp(Number(e.target.value), 0.05, 10) })}
                                className="w-full"
                              />
                              <span className="text-sm tabular-nums w-14 text-right">{d.scale.toFixed(2)}x</span>
                            </div>
                          </Labeled>

                          <Labeled label="Ilosc">
                            <NumberInput value={d.qty} onChange={(v) => updateDesign(d.id, { qty: Math.max(1, Math.floor(v)) })} min={1} step={1} />
                          </Labeled>

                          <Labeled label="Czas / szt (min) (opcjonalnie)">
                            <NumberInput
                              value={d.minutesOverride ?? 0}
                              onChange={(v) => updateDesign(d.id, { minutesOverride: v <= 0 ? undefined : v })}
                              min={0}
                              step={0.5}
                            />
                          </Labeled>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title="Wycena per projekt">
              {groupedPrices.length === 0 ? (
                <div className="text-sm text-zinc-600">Dodaj projekty, aby zobaczyc wyceny.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-zinc-600">
                        <th className="py-2">Projekt</th>
                        <th className="py-2">Ilosc</th>
                        <th className="py-2">Cena / szt</th>
                        <th className="py-2">Suma</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupedPrices.map((r) => (
                        <tr key={r.designId} className="border-t border-zinc-200">
                          <td className="py-2 font-medium">{r.name}</td>
                          <td className="py-2 tabular-nums">{r.qty}</td>
                          <td className="py-2 tabular-nums">{r.unit.toFixed(2)} PLN</td>
                          <td className="py-2 tabular-nums">{r.total.toFixed(2)} PLN</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-zinc-600 mt-2">
                Algorytm dzieli koszty czasu (energia+amortyzacja+robocizna) proporcjonalnie do minut na sztuke. Material dzielony jest
                proporcjonalnie do pola bbox. Jesli chcesz, dodamy narzut (marza/odpad/minimalna kwota) i koszt pakowania/wysylki.
              </p>
            </Card>
          </div>
        </div>

        <div className="mt-8 text-xs text-zinc-500">
          <p>
            Roadmap: (1) rotacje 90° i lepsze sortowanie, (2) nesting po poligonach (no-fit), (3) odczyt dlugosci sciezek z SVG/DXF,
            (4) profile materialow (sklejka 3/4/6mm) i presety LightBurn, (5) konta klientow + eksport PDF oferty.
          </p>
        </div>
      </div>
    </div>
  );
}

// ------------------------- UI bits -------------------------

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl bg-white border border-zinc-200 shadow-sm p-4">
      <div className="font-semibold">{title}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="text-sm text-zinc-700">{label}</div>
      <div className="w-40">{children}</div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-600 mb-1">{label}</div>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      className="w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm tabular-nums"
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3">
      <div className="text-xs text-zinc-600">{label}</div>
      <div className="text-base font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
