## What the numbers say

Measured 2026-09-10 on a 16 GB Apple-silicon Mac in headless Chrome 151 with Metal WebGPU, on the three synthetic fixture sets (no real patient data). Scores are per document, averaged. Pipelines are ranked by F1, the balance of recall and precision. Recall still deserves the closest look per type, because a missed identifier is a leak. Precision for the NER + LLM rows is a lower bound: the app's LLM validation pass, which removes detector false positives, is not simulated.

| Pipeline (as selectable in the app) | Mean F1 | App notes (4 docs) | Oncology interview (34k chars) | MedDeID sample (24 docs) |
| --- | --- | --- | --- | --- |
| **Multilingual BERT NER + Qwen3.5 2B** (best measured, app default) | **85%** | **93%** F1 · 91% rec · 96% prec | **90%** F1 · 86% rec · 95% prec | **71%** F1 · 69% rec · 85% prec |
| Qwen3.5 2B only | 80% | 90% · 84% · 98% | 83% · 75% · 94% | 67% · 64% · 86% |
| GLiNER PII Edge + Qwen3.5 2B | 77% | 92% · 96% · 89% | 75% · 94% · 63% | 64% · 84% · 53% |
| Multilingual PII NER (XLM-R) + Qwen3.5 2B | 69% | 74% · 96% · 60% | 78% · 84% · 73% | 55% · 70% · 51% |
| OpenAI Privacy Filter + Qwen3.5 2B | 66% | 67% · 88% · 54% | 72% · 77% · 68% | 59% · 71% · 54% |
| GLiNER PII Edge only (app fallback without WebGPU) | 61% | 81% · 79% · 83% | 53% · 58% · 49% | 50% · 67% · 42% |
| Multilingual BERT NER only | 59% | 67% · 54% · 93% | 66% · 50% · 97% | 43% · 30% · 87% |
| Multilingual PII NER (XLM-R) only | 37% | 47% · 58% · 40% | 29% · 44% · 21% | 35% · 42% · 34% |
| OpenAI Privacy Filter only | 19% | 21% · 20% · 22% | 17% · 14% · 22% | 20% · 18% · 25% |

Cells read F1 · recall · precision.

- **Default (since 2026-10-28):** **Multilingual BERT NER + Qwen3.5 2B**, the highest F1 on every set. BERT NER is precise (87–97%) and adds names, places and organisations that Qwen misses, so the union gains recall without losing precision. It never touched a clinical concept on the interview (0% over-redaction). Devices that cannot run Qwen fall back to **GLiNER PII Edge** alone, the best detector-only F1.
- **Highest recall:** **GLiNER PII Edge + Qwen3.5 2B** finds the most identifiers on every set (84–96%), but over-redacts clinical terms (on the interview 22% of the concepts that should be kept, e.g. *HER2-negatief*, *paclitaxel*). Its union precision is a lower bound because the LLM validation pass is not simulated, so its real F1 is likely higher than shown. Choose it when missing an identifier costs more than extra review.
- **The OpenAI Privacy Filter, the app's default detector until 2026-10-28, is not suitable for Dutch clinical text** (14–20% recall, mostly e-mail and phone numbers).
- **Qwen3.5 2B alone** is the most precise option and never touched a clinical concept, but it misses roughly a quarter of identifiers on long text (dates without a year, streets, relatives' ages written as words, institutions).
- **Re-identification (interview gold, 18 risk groups):** the best union neutralises 62% of the quasi-identifier elements and 15–16 of 18 risk groups. The groups that stay open are built from profession, employment pattern and clinical detail combined with age and place; no entity detector covers those, so they need PROFESSION detection (not in the app yet: 1–12 of 21 on MedDeID) and a generalisation policy, not more entity removal.
- **Time on this machine:** Qwen3.5 2B ≈ 19 s per short note, 155 s for the 34k-char interview (15 chunks); GLiNER 2–4 s per note, 130 s on the interview (CPU, single-threaded). Peak JS heap: GLiNER +50 MB, Qwen3.5 2B +1.9–2.0 GB.
- **Not measured:** Qwen3.5 4B — its 3.9 GB download did not fit on the benchmark machine's disk. Run it from the Benchmark tab on a machine with space; it is the same click.
- **Two bugs this run exposed and fixed the same day:** Qwen3.5 2B looping on transcript text (now interrupted at the first repeated objects and salvaged; the interview went from 42% to 75% recall and from 15 min to 2.5 min), and GLiNER failing to load on cross-origin-isolated hosting (its bundled ONNX runtime spawned a cross-origin worker; now forced single-threaded).
- **Caveats:** synthetic documents; MedDeID is Belgian Dutch (Flemish hospitals, +32 numbers); whole-word overlap scoring is lenient compared with span-level evaluation (a prediction that overlaps any part of a gold identifier counts), so these numbers are for comparing options, not for claiming compliance.
