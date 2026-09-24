# pglite-v-pgrust benchmark run

> **2026-09-24: this Run's OPFS columns were taken in the bench's old, off-the-record context,**
> where Chromium keeps OPFS in memory in the browser process and every access-handle call is a round
> trip to it. On the on-disk profile the lane now uses, PGlite OPFS repacked (relaxed) is 1.05×
> PGlite Memory against the old lane's 1.68×, both measured on 2026-09-24 — see [2026-09-24, the
> persistent context](2026-09-24-persistent-context.md), which re-measured that column and the
> pgrust Postmaster OPFS one only. PGlite Memory measured the same in both lanes; no number here was
> changed.

- Browser: chromium
- Started: 2026-09-06T10:24:39.367Z
- Driver: bun run bench

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 08a306441f | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

### Speedtest Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 08a306441f | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | PGlite OPFS repacked (relaxed) (ms) | vs PGlite Memory | PGlite OPFS repacked (strict) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | pgrust Memory (unlogged) (ms) | vs PGlite Memory | pgrust Threads Memory (ms) | vs PGlite Memory | pgrust Threads Memory (broker, pre-release store) (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory | wa-sqlite Memory (journal off) (ms) | vs PGlite Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test 1: 1000 INSERTs | 57.740 | 56.730 | 0.98× | 78.615 | 1.36× | 83.430 | 1.44× | 371.900 | 6.44× | 352.445 | 6.10× | 368.040 | 6.37× | 90.330 | 1.56× | 105.995 | 1.84× | 63.855 | 1.11× |
| Test 2: 25000 INSERTs in a transaction | 548.230 | 554.385 | 1.01× | 698.380 | 1.27× | 716.930 | 1.31× | 5154.235 | 9.40× | 5052.755 | 9.22× | 5153.815 | 9.40× | 4608.245 | 8.41× | 141.995 | 0.26× | 144.620 | 0.26× |
| Test 2.1: 25000 INSERTs in single statement | 141.895 | 131.635 | 0.93× | 246.505 | 1.74× | 239.885 | 1.69× | 208.375 | 1.47× | 178.535 | 1.26× | 206.370 | 1.45× | 238.295 | 1.68× | 38.875 | 0.27× | 39.705 | 0.28× |
| Test 3: 25000 INSERTs into an indexed table | 727.145 | 641.835 | 0.88× | 1737.545 | 2.39× | 1713.485 | 2.36× | 4955.750 | 6.82× | 4765.995 | 6.55× | 4996.795 | 6.87× | 5144.000 | 7.07× | 213.575 | 0.29× | 190.795 | 0.26× |
| Test 3.1: 25000 INSERTs into an indexed table in single statement | 168.185 | 155.045 | 0.92× | 317.705 | 1.89× | 320.925 | 1.91× | 226.875 | 1.35× | 197.080 | 1.17× | 237.955 | 1.41× | 288.390 | 1.71× | 60.500 | 0.36× | 60.110 | 0.36× |
| Test 4: 100 SELECTs without an index | 342.445 | 316.110 | 0.92× | 307.815 | 0.90× | 315.885 | 0.92× | 402.890 | 1.18× | 388.860 | 1.14× | 406.650 | 1.19× | 326.540 | 0.95× | 197.820 | 0.58× | 206.735 | 0.60× |
| Test 5: 100 SELECTs on a string comparison | 814.700 | 796.000 | 0.98× | 797.115 | 0.98× | 798.410 | 0.98× | 696.890 | 0.86× | 697.720 | 0.86× | 722.620 | 0.89× | 679.625 | 0.83× | 806.825 | 0.99× | 811.250 | 1.00× |
| Test 6: Creating an index | 29.725 | 28.260 | 0.95× | 82.320 | 2.77× | 81.520 | 2.74× | 34.105 | 1.15× | 34.540 | 1.16× | 35.025 | 1.18× | 80.030 | 2.69× | 25.295 | 0.85× | 25.795 | 0.87× |
| Test 7: 5000 SELECTs with an index | 455.410 | 462.550 | 1.02× | 508.720 | 1.12× | 501.950 | 1.10× | 1163.495 | 2.55× | 1117.660 | 2.45× | 1128.550 | 2.48× | 945.905 | 2.08× | 74.910 | 0.16× | 78.065 | 0.17× |
| Test 8: 1000 UPDATEs without an index | 173.240 | 164.440 | 0.95× | 171.385 | 0.99× | 173.885 | 1.00× | 265.625 | 1.53× | 251.810 | 1.45× | 263.525 | 1.52× | 286.000 | 1.65× | 58.570 | 0.34× | 58.195 | 0.34× |
| Test 9: 25000 UPDATEs with an index | 1368.930 | 1294.675 | 0.95× | 1955.910 | 1.43× | 1960.990 | 1.43× | 4993.790 | 3.65× | 4814.590 | 3.52× | 5090.800 | 3.72× | 4987.230 | 3.64× | 258.045 | 0.19× | 245.020 | 0.18× |
| Test 10: 25000 text UPDATEs with an index | 1756.075 | 1586.505 | 0.90× | 2871.840 | 1.64× | 2876.105 | 1.64× | 6358.015 | 3.62× | 6184.935 | 3.52× | 6507.230 | 3.71× | 6793.310 | 3.87× | 200.730 | 0.11× | 193.290 | 0.11× |
| Test 11: INSERTs from a SELECT | 290.865 | 166.425 | 0.57× | 1334.985 | 4.59× | 1336.835 | 4.60× | 316.800 | 1.09× | 201.250 | 0.69× | 332.495 | 1.14× | 695.405 | 2.39× | 85.795 | 0.29× | 81.810 | 0.28× |
| Test 12: DELETE without an index | 25.365 | 19.410 | 0.77× | 28.425 | 1.12× | 27.390 | 1.08× | 36.910 | 1.46× | 26.295 | 1.04× | 36.230 | 1.43× | 87.570 | 3.45× | 45.285 | 1.79× | 32.305 | 1.27× |
| Test 13: DELETE with an index | 32.295 | 22.610 | 0.70× | 43.115 | 1.34× | 42.290 | 1.31× | 67.785 | 2.10× | 41.315 | 1.28× | 72.540 | 2.25× | 140.225 | 4.34× | 63.485 | 1.97× | 61.435 | 1.90× |
| Test 14: A big INSERT after a big DELETE | 168.625 | 134.225 | 0.80× | 503.795 | 2.99× | 523.055 | 3.10× | 243.300 | 1.44× | 167.900 | 1.00× | 255.360 | 1.51× | 404.750 | 2.40× | 63.615 | 0.38× | 62.460 | 0.37× |
| Test 15: A big DELETE followed by many small INSERTs | 238.600 | 230.110 | 0.96× | 314.940 | 1.32× | 305.010 | 1.28× | 1343.665 | 5.63× | 1271.290 | 5.33× | 1377.580 | 5.77× | 1464.670 | 6.14× | 56.340 | 0.24× | 52.040 | 0.22× |
| Test 16: DROP TABLE | 6.095 | 4.815 | 0.79× | 25.235 | 4.14× | 24.665 | 4.05× | 9.060 | 1.49× | 9.010 | 1.48× | 9.645 | 1.58× | 67.830 | 11.13× | 8.015 | 1.32× | 5.900 | 0.97× |

### RTT Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 08a306441f | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | PGlite OPFS repacked (relaxed) (ms) | vs PGlite Memory | PGlite OPFS repacked (strict) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | pgrust Memory (unlogged) (ms) | vs PGlite Memory | pgrust Threads Memory (ms) | vs PGlite Memory | pgrust Threads Memory (broker, pre-release store) (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory | wa-sqlite Memory (journal off) (ms) | vs PGlite Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test 1: insert small row | 0.370 | 0.257 | 0.70× | 0.711 | 1.92× | 0.649 | 1.76× | 0.409 | 1.11× | 0.389 | 1.05× | 0.552 | 1.49× | 25.700 | 69.54× | 0.168 | 0.45× | 0.079 | 0.21× |
| Test 2: select small row | 0.264 | 0.341 | 1.29× | 0.364 | 1.38× | 0.291 | 1.10× | 0.337 | 1.27× | 0.396 | 1.50× | 0.404 | 1.53× | 0.273 | 1.03× | 0.054 | 0.20× | 0.061 | 0.23× |
| Test 3: update small row | 0.263 | 0.320 | 1.22× | 0.247 | 0.94× | 0.248 | 0.94× | 0.412 | 1.57× | 0.427 | 1.62× | 0.404 | 1.54× | 0.272 | 1.04× | 0.047 | 0.18× | 0.052 | 0.20× |
| Test 4: delete small row | 0.407 | 0.419 | 1.03× | 0.816 | 2.01× | 0.832 | 2.04× | 1.058 | 2.60× | 1.148 | 2.82× | 1.174 | 2.88× | 25.899 | 63.62× | 0.144 | 0.35× | 0.094 | 0.23× |
| Test 5: insert 1kb row | 0.251 | 0.245 | 0.98× | 0.666 | 2.66× | 0.690 | 2.75× | 0.397 | 1.58× | 0.368 | 1.47× | 0.372 | 1.49× | 25.325 | 100.97× | 0.120 | 0.48× | 0.071 | 0.28× |
| Test 6: select 1kb row | 0.394 | 0.406 | 1.03× | 0.387 | 0.98× | 0.398 | 1.01× | 0.956 | 2.43× | 0.817 | 2.07× | 1.002 | 2.54× | 0.595 | 1.51× | 0.081 | 0.20× | 0.076 | 0.19× |
| Test 7: update 1kb row | 0.273 | 0.266 | 0.97× | 0.716 | 2.62× | 0.737 | 2.70× | 0.378 | 1.38× | 0.353 | 1.29× | 0.392 | 1.43× | 25.246 | 92.35× | 0.051 | 0.19× | 0.055 | 0.20× |
| Test 8: delete 1kb row | 0.408 | 0.380 | 0.93× | 0.864 | 2.12× | 0.817 | 2.00× | 0.738 | 1.81× | 0.802 | 1.97× | 0.939 | 2.30× | 25.304 | 62.08× | 0.135 | 0.33× | 0.084 | 0.21× |
| Test 9: insert 10kb row | 0.375 | 0.363 | 0.97× | 0.791 | 2.11× | 0.769 | 2.05× | 0.476 | 1.27× | 0.494 | 1.32× | 0.649 | 1.73× | 25.827 | 68.87× | 0.195 | 0.52× | 0.155 | 0.41× |
| Test 10: select 10kb row | 0.492 | 0.439 | 0.89× | 0.423 | 0.86× | 0.423 | 0.86× | 0.574 | 1.17× | 0.654 | 1.33× | 0.758 | 1.54× | 0.581 | 1.18× | 0.095 | 0.19× | 0.100 | 0.20× |
| Test 11: update 10kb row | 0.329 | 0.331 | 1.01× | 0.323 | 0.98× | 0.340 | 1.03× | 0.364 | 1.11× | 0.354 | 1.08× | 0.367 | 1.12× | 0.321 | 0.98× | 0.091 | 0.28× | 0.091 | 0.28× |
| Test 12: delete 10kb row | 0.378 | 0.398 | 1.05× | 0.800 | 2.12× | 0.814 | 2.15× | 0.637 | 1.68× | 0.562 | 1.49× | 0.691 | 1.83× | 25.384 | 67.10× | 0.139 | 0.37× | 0.081 | 0.21× |
