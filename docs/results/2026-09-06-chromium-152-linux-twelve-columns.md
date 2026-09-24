# pglite-v-pgrust benchmark run

> **2026-09-24: this Run's OPFS columns were taken in the bench's old, off-the-record context,**
> where Chromium keeps OPFS in memory in the browser process and every access-handle call is a round
> trip to it. On the on-disk profile the lane now uses, PGlite OPFS repacked (relaxed) is 1.05×
> PGlite Memory against the old lane's 1.68×, both measured on 2026-09-24 — see [2026-09-24, the
> persistent context](2026-09-24-persistent-context.md), which re-measured that column and the
> pgrust Postmaster OPFS one only. PGlite Memory measured the same in both lanes; no number here was
> changed.

- Browser: chromium
- Started: 2026-09-06T11:37:11.047Z
- Driver: bun run bench

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 08a306441f | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

### Speedtest Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 08a306441f | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | PGlite OPFS repacked (relaxed) (ms) | vs PGlite Memory | PGlite OPFS repacked (strict) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | pgrust Memory (unlogged) (ms) | vs PGlite Memory | pgrust Threads Memory (ms) | vs PGlite Memory | pgrust Threads Memory (broker, pre-release store) (ms) | vs PGlite Memory | pgrust Threads OPFS repacked (relaxed, pre-release store) (ms) | vs PGlite Memory | pgrust Threads OPFS repacked (strict, pre-release store) (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory | wa-sqlite Memory (journal off) (ms) | vs PGlite Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test 1: 1000 INSERTs | 54.120 | 66.000 | 1.22× | 86.005 | 1.59× | 84.910 | 1.57× | 366.765 | 6.78× | 358.575 | 6.63× | 359.335 | 6.64× | 67.435 | 1.25× | 99.660 | 1.84× | 100.530 | 1.86× | 108.800 | 2.01× | 53.840 | 0.99× |
| Test 2: 25000 INSERTs in a transaction | 570.305 | 541.045 | 0.95× | 708.180 | 1.24× | 727.415 | 1.28× | 5143.885 | 9.02× | 5069.610 | 8.89× | 5177.470 | 9.08× | 4607.625 | 8.08× | 5013.885 | 8.79× | 5081.150 | 8.91× | 143.305 | 0.25× | 137.145 | 0.24× |
| Test 2.1: 25000 INSERTs in single statement | 141.430 | 130.990 | 0.93× | 267.210 | 1.89× | 245.870 | 1.74× | 212.985 | 1.51× | 176.935 | 1.25× | 217.910 | 1.54× | 210.730 | 1.49× | 429.380 | 3.04× | 547.540 | 3.87× | 38.955 | 0.28× | 39.270 | 0.28× |
| Test 3: 25000 INSERTs into an indexed table | 753.915 | 633.695 | 0.84× | 1725.000 | 2.29× | 1737.840 | 2.31× | 4983.020 | 6.61× | 4790.725 | 6.35× | 5023.740 | 6.66× | 5050.865 | 6.70× | 6656.315 | 8.83× | 7368.115 | 9.77× | 193.870 | 0.26× | 193.860 | 0.26× |
| Test 3.1: 25000 INSERTs into an indexed table in single statement | 163.905 | 152.345 | 0.93× | 321.520 | 1.96× | 342.105 | 2.09× | 225.145 | 1.37× | 203.580 | 1.24× | 226.155 | 1.38× | 256.105 | 1.56× | 585.540 | 3.57× | 702.095 | 4.28× | 62.815 | 0.38× | 59.495 | 0.36× |
| Test 4: 100 SELECTs without an index | 316.385 | 328.410 | 1.04× | 303.260 | 0.96× | 317.870 | 1.00× | 398.800 | 1.26× | 412.640 | 1.30× | 395.110 | 1.25× | 311.765 | 0.99× | 316.510 | 1.00× | 320.780 | 1.01× | 200.885 | 0.63× | 195.540 | 0.62× |
| Test 5: 100 SELECTs on a string comparison | 811.535 | 845.990 | 1.04× | 785.000 | 0.97× | 805.815 | 0.99× | 686.485 | 0.85× | 720.215 | 0.89× | 723.495 | 0.89× | 687.130 | 0.85× | 683.735 | 0.84× | 686.420 | 0.85× | 794.630 | 0.98× | 799.090 | 0.98× |
| Test 6: Creating an index | 29.105 | 28.355 | 0.97× | 80.750 | 2.77× | 80.235 | 2.76× | 33.635 | 1.16× | 33.685 | 1.16× | 34.185 | 1.17× | 41.265 | 1.42× | 141.995 | 4.88× | 178.835 | 6.14× | 25.470 | 0.88× | 24.870 | 0.85× |
| Test 7: 5000 SELECTs with an index | 476.705 | 452.205 | 0.95× | 493.405 | 1.04× | 498.275 | 1.05× | 1124.035 | 2.36× | 1129.000 | 2.37× | 1142.595 | 2.40× | 946.935 | 1.99× | 949.940 | 1.99× | 931.240 | 1.95× | 76.495 | 0.16× | 93.905 | 0.20× |
| Test 8: 1000 UPDATEs without an index | 177.230 | 165.250 | 0.93× | 169.400 | 0.96× | 175.165 | 0.99× | 247.555 | 1.40× | 255.740 | 1.44× | 272.555 | 1.54× | 235.565 | 1.33× | 251.080 | 1.42× | 249.365 | 1.41× | 63.685 | 0.36× | 60.345 | 0.34× |
| Test 9: 25000 UPDATEs with an index | 1363.870 | 1303.550 | 0.96× | 1939.740 | 1.42× | 1969.370 | 1.44× | 5068.825 | 3.72× | 4801.400 | 3.52× | 5123.105 | 3.76× | 4936.440 | 3.62× | 5719.025 | 4.19× | 5849.350 | 4.29× | 261.025 | 0.19× | 256.015 | 0.19× |
| Test 10: 25000 text UPDATEs with an index | 1718.300 | 1591.435 | 0.93× | 2896.935 | 1.69× | 2902.395 | 1.69× | 6417.840 | 3.73× | 6169.190 | 3.59× | 6535.345 | 3.80× | 6835.375 | 3.98× | 8546.295 | 4.97× | 9111.120 | 5.30× | 214.765 | 0.12× | 206.010 | 0.12× |
| Test 11: INSERTs from a SELECT | 284.935 | 183.980 | 0.65× | 1308.375 | 4.59× | 1310.825 | 4.60× | 314.235 | 1.10× | 200.835 | 0.70× | 333.710 | 1.17× | 521.345 | 1.83× | 1935.220 | 6.79× | 2633.880 | 9.24× | 84.440 | 0.30× | 80.615 | 0.28× |
| Test 12: DELETE without an index | 23.060 | 20.745 | 0.90× | 27.220 | 1.18× | 26.795 | 1.16× | 36.240 | 1.57× | 27.010 | 1.17× | 36.045 | 1.56× | 34.820 | 1.51× | 52.205 | 2.26× | 54.325 | 2.36× | 42.980 | 1.86× | 32.285 | 1.40× |
| Test 13: DELETE with an index | 28.530 | 20.775 | 0.73× | 41.500 | 1.45× | 41.470 | 1.45× | 67.560 | 2.37× | 41.750 | 1.46× | 70.050 | 2.46× | 82.255 | 2.88× | 142.165 | 4.98× | 144.005 | 5.05× | 63.120 | 2.21× | 61.955 | 2.17× |
| Test 14: A big INSERT after a big DELETE | 168.330 | 135.800 | 0.81× | 500.835 | 2.98× | 497.370 | 2.95× | 238.910 | 1.42× | 165.930 | 0.99× | 251.725 | 1.50× | 351.020 | 2.09× | 841.115 | 5.00× | 924.615 | 5.49× | 64.515 | 0.38× | 62.970 | 0.37× |
| Test 15: A big DELETE followed by many small INSERTs | 245.870 | 232.050 | 0.94× | 303.740 | 1.24× | 318.970 | 1.30× | 1339.235 | 5.45× | 1270.680 | 5.17× | 1377.855 | 5.60× | 1406.840 | 5.72× | 1607.565 | 6.54× | 1619.755 | 6.59× | 59.010 | 0.24× | 58.415 | 0.24× |
| Test 16: DROP TABLE | 6.110 | 5.030 | 0.82× | 25.680 | 4.20× | 30.775 | 5.04× | 8.905 | 1.46× | 9.060 | 1.48× | 9.710 | 1.59× | 10.835 | 1.77× | 17.230 | 2.82× | 17.725 | 2.90× | 5.940 | 0.97× | 5.730 | 0.94× |

### RTT Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust 08a306441f | wa-sqlite v1.1.2 (github) | JSPI available | cross-origin isolated yes | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | PGlite OPFS repacked (relaxed) (ms) | vs PGlite Memory | PGlite OPFS repacked (strict) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | pgrust Memory (unlogged) (ms) | vs PGlite Memory | pgrust Threads Memory (ms) | vs PGlite Memory | pgrust Threads Memory (broker, pre-release store) (ms) | vs PGlite Memory | pgrust Threads OPFS repacked (relaxed, pre-release store) (ms) | vs PGlite Memory | pgrust Threads OPFS repacked (strict, pre-release store) (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory | wa-sqlite Memory (journal off) (ms) | vs PGlite Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test 1: insert small row | 0.414 | 0.410 | 0.99× | 0.698 | 1.69× | 0.706 | 1.71× | 0.415 | 1.00× | 0.412 | 1.00× | 0.542 | 1.31× | 0.395 | 0.95× | 0.721 | 1.74× | 0.676 | 1.64× | 0.129 | 0.31× | 0.081 | 0.20× |
| Test 2: select small row | 0.385 | 0.399 | 1.04× | 0.303 | 0.79× | 0.379 | 0.98× | 0.300 | 0.78× | 0.296 | 0.77× | 0.403 | 1.05× | 0.259 | 0.67× | 0.258 | 0.67× | 0.229 | 0.59× | 0.065 | 0.17× | 0.061 | 0.16× |
| Test 3: update small row | 0.274 | 0.252 | 0.92× | 0.265 | 0.97× | 0.285 | 1.04× | 0.412 | 1.50× | 0.407 | 1.49× | 0.405 | 1.48× | 0.271 | 0.99× | 0.267 | 0.97× | 0.241 | 0.88× | 0.065 | 0.24× | 0.052 | 0.19× |
| Test 4: delete small row | 0.418 | 0.384 | 0.92× | 0.815 | 1.95× | 0.835 | 1.99× | 1.151 | 2.75× | 0.966 | 2.31× | 1.126 | 2.69× | 0.835 | 2.00× | 1.104 | 2.64× | 1.039 | 2.48× | 0.145 | 0.35× | 0.092 | 0.22× |
| Test 5: insert 1kb row | 0.289 | 0.235 | 0.81× | 0.759 | 2.63× | 0.698 | 2.42× | 0.382 | 1.32× | 0.373 | 1.29× | 0.377 | 1.30× | 0.396 | 1.37× | 0.811 | 2.81× | 0.829 | 2.87× | 0.182 | 0.63× | 0.082 | 0.29× |
| Test 6: select 1kb row | 0.469 | 0.387 | 0.83× | 0.404 | 0.86× | 0.411 | 0.88× | 0.991 | 2.11× | 0.958 | 2.04× | 1.008 | 2.15× | 0.626 | 1.34× | 0.501 | 1.07× | 0.503 | 1.07× | 0.077 | 0.17× | 0.080 | 0.17× |
| Test 7: update 1kb row | 0.275 | 0.262 | 0.95× | 0.709 | 2.58× | 0.747 | 2.71× | 0.376 | 1.37× | 0.405 | 1.47× | 0.389 | 1.41× | 0.482 | 1.75× | 0.895 | 3.25× | 0.910 | 3.31× | 0.050 | 0.18× | 0.050 | 0.18× |
| Test 8: delete 1kb row | 0.431 | 0.374 | 0.87× | 0.819 | 1.90× | 0.812 | 1.88× | 0.919 | 2.13× | 0.782 | 1.81× | 0.966 | 2.24× | 0.740 | 1.72× | 1.081 | 2.51× | 1.044 | 2.42× | 0.156 | 0.36× | 0.105 | 0.24× |
| Test 9: insert 10kb row | 0.372 | 0.376 | 1.01× | 0.748 | 2.01× | 0.763 | 2.05× | 0.558 | 1.50× | 0.502 | 1.35× | 0.604 | 1.62× | 0.571 | 1.53× | 0.872 | 2.34× | 0.888 | 2.38× | 0.192 | 0.52× | 0.147 | 0.39× |
| Test 10: select 10kb row | 0.481 | 0.509 | 1.06× | 0.426 | 0.89× | 0.414 | 0.86× | 0.644 | 1.34× | 0.663 | 1.38× | 0.643 | 1.34× | 0.632 | 1.31× | 0.544 | 1.13× | 0.511 | 1.06× | 0.101 | 0.21× | 0.106 | 0.22× |
| Test 11: update 10kb row | 0.344 | 0.322 | 0.94× | 0.337 | 0.98× | 0.338 | 0.98× | 0.370 | 1.08× | 0.325 | 0.95× | 0.351 | 1.02× | 0.334 | 0.97× | 0.321 | 0.93× | 0.351 | 1.02× | 0.092 | 0.27× | 0.089 | 0.26× |
| Test 12: delete 10kb row | 0.375 | 0.372 | 0.99× | 0.833 | 2.22× | 0.850 | 2.27× | 0.570 | 1.52× | 0.582 | 1.55× | 0.632 | 1.68× | 0.828 | 2.21× | 1.055 | 2.81× | 1.030 | 2.75× | 0.144 | 0.38× | 0.099 | 0.26× |
