# pglite-v-pgrust benchmark run

> **2026-09-24: this Run's OPFS columns were taken in the bench's old, off-the-record context,**
> where Chromium keeps OPFS in memory in the browser process and every access-handle call is a round
> trip to it. On the on-disk profile the lane now uses, PGlite OPFS repacked (relaxed) is 1.05×
> PGlite Memory against the old lane's 1.68×, both measured on 2026-09-24 — see [2026-09-24, the
> persistent context](2026-09-24-persistent-context.md), which re-measured that column and the
> pgrust Postmaster OPFS one only. PGlite Memory measured the same in both lanes; no number here was
> changed.

- Browser: chromium
- Started: 2026-09-06T09:24:23.194Z
- Driver: bun run bench

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

### Speedtest Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | PGlite OPFS repacked (relaxed) (ms) | vs PGlite Memory | PGlite OPFS repacked (strict) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | pgrust Memory (unlogged) (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory | wa-sqlite Memory (journal off) (ms) | vs PGlite Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test 1: 1000 INSERTs | 57.700 | 56.000 | 0.97× | 86.900 | 1.51× | 90.700 | 1.57× | 361.400 | 6.26× | 352.800 | 6.11× | 118.000 | 2.05× | 68.000 | 1.18× |
| Test 2: 25000 INSERTs in a transaction | 593.900 | 551.600 | 0.93× | 694.700 | 1.17× | 713.900 | 1.20× | 5276.100 | 8.88× | 5042.000 | 8.49× | 140.900 | 0.24× | 141.300 | 0.24× |
| Test 2.1: 25000 INSERTs in single statement | 142.700 | 125.800 | 0.88× | 236.200 | 1.66× | 241.300 | 1.69× | 218.700 | 1.53× | 175.300 | 1.23× | 42.800 | 0.30× | 40.300 | 0.28× |
| Test 3: 25000 INSERTs into an indexed table | 745.400 | 633.200 | 0.85× | 1701.200 | 2.28× | 1754.200 | 2.35× | 5142.300 | 6.90× | 4786.200 | 6.42× | 184.300 | 0.25× | 182.400 | 0.24× |
| Test 3.1: 25000 INSERTs into an indexed table in single statement | 165.700 | 153.400 | 0.93× | 327.400 | 1.98× | 329.800 | 1.99× | 226.600 | 1.37× | 204.100 | 1.23× | 62.300 | 0.38× | 60.200 | 0.36× |
| Test 4: 100 SELECTs without an index | 310.500 | 318.700 | 1.03× | 309.600 | 1.00× | 311.500 | 1.00× | 447.900 | 1.44× | 404.600 | 1.30× | 200.600 | 0.65× | 193.800 | 0.62× |
| Test 5: 100 SELECTs on a string comparison | 796.100 | 817.500 | 1.03× | 801.100 | 1.01× | 789.300 | 0.99× | 756.800 | 0.95× | 705.200 | 0.89× | 815.500 | 1.02× | 819.100 | 1.03× |
| Test 6: Creating an index | 29.200 | 29.000 | 0.99× | 82.500 | 2.83× | 84.900 | 2.91× | 33.900 | 1.16× | 34.400 | 1.18× | 26.500 | 0.91× | 24.500 | 0.84× |
| Test 7: 5000 SELECTs with an index | 456.800 | 475.100 | 1.04× | 512.200 | 1.12× | 492.400 | 1.08× | 1144.800 | 2.51× | 1127.700 | 2.47× | 76.400 | 0.17× | 78.000 | 0.17× |
| Test 8: 1000 UPDATEs without an index | 171.200 | 172.500 | 1.01× | 171.800 | 1.00× | 175.000 | 1.02× | 246.700 | 1.44× | 243.800 | 1.42× | 59.900 | 0.35× | 65.500 | 0.38× |
| Test 9: 25000 UPDATEs with an index | 1355.100 | 1307.500 | 0.96× | 1987.700 | 1.47× | 1975.500 | 1.46× | 5066.900 | 3.74× | 4778.700 | 3.53× | 252.500 | 0.19× | 248.700 | 0.18× |
| Test 10: 25000 text UPDATEs with an index | 1728.200 | 1562.300 | 0.90× | 2901.700 | 1.68× | 2893.500 | 1.67× | 6471.400 | 3.74× | 6222.900 | 3.60× | 201.100 | 0.12× | 192.700 | 0.11× |
| Test 11: INSERTs from a SELECT | 287.500 | 167.500 | 0.58× | 1337.900 | 4.65× | 1357.700 | 4.72× | 313.800 | 1.09× | 199.700 | 0.69× | 83.200 | 0.29× | 79.200 | 0.28× |
| Test 12: DELETE without an index | 26.400 | 21.700 | 0.82× | 30.600 | 1.16× | 25.800 | 0.98× | 34.200 | 1.30× | 26.200 | 0.99× | 45.800 | 1.73× | 32.200 | 1.22× |
| Test 13: DELETE with an index | 32.700 | 21.900 | 0.67× | 42.400 | 1.30× | 41.800 | 1.28× | 65.200 | 1.99× | 41.900 | 1.28× | 62.600 | 1.91× | 62.600 | 1.91× |
| Test 14: A big INSERT after a big DELETE | 172.000 | 139.600 | 0.81× | 511.900 | 2.98× | 507.600 | 2.95× | 240.600 | 1.40× | 168.300 | 0.98× | 65.800 | 0.38× | 62.900 | 0.37× |
| Test 15: A big DELETE followed by many small INSERTs | 246.700 | 224.300 | 0.91× | 307.700 | 1.25× | 301.300 | 1.22× | 1365.200 | 5.53× | 1272.700 | 5.16× | 56.200 | 0.23× | 52.000 | 0.21× |
| Test 16: DROP TABLE | 5.400 | 5.600 | 1.04× | 24.600 | 4.56× | 31.400 | 5.81× | 12.900 | 2.39× | 9.500 | 1.76× | 6.700 | 1.24× | 5.800 | 1.07× |

### RTT Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | @pgxsinkit/pglite-opfs-repacked 0.3.0 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | OPFS sync access available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | PGlite OPFS repacked (relaxed) (ms) | vs PGlite Memory | PGlite OPFS repacked (strict) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | pgrust Memory (unlogged) (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory | wa-sqlite Memory (journal off) (ms) | vs PGlite Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test 1: insert small row | 0.254 | 0.261 | 1.03× | 0.724 | 2.85× | 0.704 | 2.77× | 0.439 | 1.73× | 0.415 | 1.64× | 0.175 | 0.69× | 0.080 | 0.32× |
| Test 2: select small row | 0.268 | 0.281 | 1.05× | 0.428 | 1.60× | 0.295 | 1.10× | 0.338 | 1.26× | 0.344 | 1.29× | 0.068 | 0.25× | 0.048 | 0.18× |
| Test 3: update small row | 0.257 | 0.366 | 1.42× | 0.271 | 1.05× | 0.271 | 1.05× | 0.381 | 1.48× | 0.410 | 1.59× | 0.066 | 0.26× | 0.054 | 0.21× |
| Test 4: delete small row | 0.454 | 0.444 | 0.98× | 0.815 | 1.80× | 0.820 | 1.81× | 1.164 | 2.56× | 1.022 | 2.25× | 0.204 | 0.45× | 0.130 | 0.29× |
| Test 5: insert 1kb row | 0.254 | 0.355 | 1.40× | 0.700 | 2.76× | 0.696 | 2.74× | 0.366 | 1.44× | 0.395 | 1.56× | 0.124 | 0.49× | 0.105 | 0.41× |
| Test 6: select 1kb row | 0.401 | 0.460 | 1.15× | 0.399 | 0.99× | 0.390 | 0.97× | 0.954 | 2.38× | 0.944 | 2.35× | 0.085 | 0.21× | 0.078 | 0.19× |
| Test 7: update 1kb row | 0.275 | 0.266 | 0.97× | 0.760 | 2.76× | 0.720 | 2.62× | 0.433 | 1.57× | 0.343 | 1.25× | 0.056 | 0.20× | 0.041 | 0.15× |
| Test 8: delete 1kb row | 0.384 | 0.363 | 0.94× | 0.851 | 2.22× | 0.818 | 2.13× | 0.814 | 2.12× | 0.793 | 2.07× | 0.151 | 0.39× | 0.089 | 0.23× |
| Test 9: insert 10kb row | 0.396 | 0.364 | 0.92× | 0.762 | 1.92× | 0.794 | 2.00× | 0.609 | 1.54× | 0.521 | 1.32× | 0.189 | 0.48× | 0.155 | 0.39× |
| Test 10: select 10kb row | 0.447 | 0.507 | 1.13× | 0.411 | 0.92× | 0.423 | 0.94× | 0.673 | 1.50× | 0.730 | 1.63× | 0.102 | 0.23× | 0.114 | 0.25× |
| Test 11: update 10kb row | 0.327 | 0.341 | 1.04× | 0.325 | 0.99× | 0.354 | 1.08× | 0.325 | 0.99× | 0.339 | 1.03× | 0.074 | 0.23× | 0.086 | 0.26× |
| Test 12: delete 10kb row | 0.388 | 0.384 | 0.99× | 0.790 | 2.04× | 0.779 | 2.01× | 0.599 | 1.55× | 0.648 | 1.67× | 0.155 | 0.40× | 0.099 | 0.25× |
