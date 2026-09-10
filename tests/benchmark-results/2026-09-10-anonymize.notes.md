## What the numbers say

Measured 2026-09-10 on a 16 GB Apple-silicon Mac in headless Chrome 151 with Metal WebGPU, on the three synthetic fixture sets (no real patient data). Recall is per document, averaged; a missed identifier is a leak, so recall is the number that matters. Precision for the NER + LLM rows is a lower bound: the app's LLM validation pass, which removes detector false positives, is not simulated.

| Pipeline (as selectable in the app) | App notes (4 docs) | Oncology interview (34k chars) | MedDeID sample (24 docs) |
| --- | --- | --- | --- |
| **GLiNER PII Edge + Qwen3.5 2B** (best measured) | **96%** recall · 89% prec | **94%** recall · 63% prec | **84%** recall · 53% prec |
| Multilingual BERT NER + Qwen3.5 2B | 91% · 96% | 86% · 95% | 69% · 85% |
| Qwen3.5 2B only | 84% · 98% | 75% · 94% | 64% · 86% |
| GLiNER PII Edge only | 79% · 83% | 58% · 49% | 67% · 42% |
| Multilingual PII NER (XLM-R) only | 58% · 40% | 44% · 21% | 42% · 34% |
| Multilingual BERT NER only | 53% · 93% | 50% · 97% | 30% · 87% |
| OpenAI Privacy Filter only | 20% · 22% | 14% · 22% | 18% · 24% |

- **Recommendation:** use **GLiNER PII Edge + Qwen3.5 2B**. It has the highest recall on every set and GLiNER is the cheapest detector (≈ 50 MB heap, 3 s load). Its weakness is over-redaction of clinical terms (on the interview 22% of the concepts that should be kept, e.g. *HER2-negatief*, *paclitaxel*); in the app the LLM validation pass and the review panel exist for exactly that.
- **The OpenAI Privacy Filter, the app's current default detector when WebGPU is available, is not suitable for Dutch clinical text** (14–20% recall, mostly e-mail and phone numbers). Switching the default to GLiNER is the single most effective change these numbers suggest.
- **Qwen3.5 2B alone** is the most precise option and never touched a clinical concept, but it misses roughly a quarter of identifiers on long text (dates without a year, streets, relatives' ages written as words, institutions).
- **Re-identification (interview gold, 18 risk groups):** the best union neutralises 62% of the quasi-identifier elements and 15–16 of 18 risk groups. The groups that stay open are built from profession, employment pattern and clinical detail combined with age and place; no entity detector covers those, so they need PROFESSION detection (not in the app yet: 1–12 of 21 on MedDeID) and a generalisation policy, not more entity removal.
- **Time on this machine:** Qwen3.5 2B ≈ 19 s per short note, 155 s for the 34k-char interview (15 chunks); GLiNER 2–4 s per note, 130 s on the interview (CPU, single-threaded). Peak JS heap: GLiNER +50 MB, Qwen3.5 2B +1.9–2.0 GB.
- **Not measured:** Qwen3.5 4B — its 3.9 GB download did not fit on the benchmark machine's disk. Run it from the Benchmark tab on a machine with space; it is the same click.
- **Two bugs this run exposed and fixed the same day:** Qwen3.5 2B looping on transcript text (now interrupted at the first repeated objects and salvaged; the interview went from 42% to 75% recall and from 15 min to 2.5 min), and GLiNER failing to load on cross-origin-isolated hosting (its bundled ONNX runtime spawned a cross-origin worker; now forced single-threaded).
- **Caveats:** synthetic documents; MedDeID is Belgian Dutch (Flemish hospitals, +32 numbers); whole-word overlap scoring is lenient compared with span-level evaluation (a prediction that overlaps any part of a gold identifier counts), so these numbers are for comparing options, not for claiming compliance.
