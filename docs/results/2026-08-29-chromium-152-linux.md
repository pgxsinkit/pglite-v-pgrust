# pglite-v-pgrust benchmark run

- Browser: chromium
- Started: 2026-08-29T03:24:46.243Z
- Driver: bun run bench

@pgxsinkit/pglite 0.5.5-pgx.2 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

### Speedtest Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark                                                         | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory |
| ----------------------------------------------------------------- | ------------------ | ----------------------------- | ---------------- | ------------------ | ---------------- | --------------------- | ---------------- |
| Test 1: 1000 INSERTs                                              | 61.300             | 56.100                        | 0.92×            | 359.400            | 5.86×            | 92.200                | 1.50×            |
| Test 2: 25000 INSERTs in a transaction                            | 569.600            | 545.600                       | 0.96×            | 5217.400           | 9.16×            | 141.200               | 0.25×            |
| Test 2.1: 25000 INSERTs in single statement                       | 138.200            | 127.000                       | 0.92×            | 242.800            | 1.76×            | 39.900                | 0.29×            |
| Test 3: 25000 INSERTs into an indexed table                       | 745.300            | 644.100                       | 0.86×            | 4972.000           | 6.67×            | 203.700               | 0.27×            |
| Test 3.1: 25000 INSERTs into an indexed table in single statement | 160.800            | 148.100                       | 0.92×            | 225.600            | 1.40×            | 75.300                | 0.47×            |
| Test 4: 100 SELECTs without an index                              | 302.600            | 298.700                       | 0.99×            | 394.900            | 1.31×            | 237.400               | 0.78×            |
| Test 5: 100 SELECTs on a string comparison                        | 813.700            | 788.900                       | 0.97×            | 776.600            | 0.95×            | 933.300               | 1.15×            |
| Test 6: Creating an index                                         | 28.500             | 28.300                        | 0.99×            | 35.300             | 1.24×            | 29.200                | 1.02×            |
| Test 7: 5000 SELECTs with an index                                | 446.800            | 469.200                       | 1.05×            | 1200.800           | 2.69×            | 101.000               | 0.23×            |
| Test 8: 1000 UPDATEs without an index                             | 160.300            | 159.800                       | 1.00×            | 267.700            | 1.67×            | 74.400                | 0.46×            |
| Test 9: 25000 UPDATEs with an index                               | 1346.800           | 1313.400                      | 0.98×            | 5264.200           | 3.91×            | 298.900               | 0.22×            |
| Test 10: 25000 text UPDATEs with an index                         | 1682.100           | 1601.800                      | 0.95×            | 6531.700           | 3.88×            | 246.500               | 0.15×            |
| Test 11: INSERTs from a SELECT                                    | 285.300            | 177.100                       | 0.62×            | 321.100            | 1.13×            | 96.200                | 0.34×            |
| Test 12: DELETE without an index                                  | 28.900             | 21.400                        | 0.74×            | 34.100             | 1.18×            | 51.200                | 1.77×            |
| Test 13: DELETE with an index                                     | 31.600             | 23.200                        | 0.73×            | 65.400             | 2.07×            | 72.800                | 2.30×            |
| Test 14: A big INSERT after a big DELETE                          | 166.600            | 137.400                       | 0.82×            | 238.100            | 1.43×            | 74.800                | 0.45×            |
| Test 15: A big DELETE followed by many small INSERTs              | 242.300            | 227.900                       | 0.94×            | 1344.100           | 5.55×            | 65.700                | 0.27×            |
| Test 16: DROP TABLE                                               | 4.800              | 5.000                         | 1.04×            | 9.100              | 1.90×            | 6.500                 | 1.35×            |

### RTT Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark                | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory |
| ------------------------ | ------------------ | ----------------------------- | ---------------- | ------------------ | ---------------- | --------------------- | ---------------- |
| Test 1: insert small row | 0.429              | 0.340                         | 0.79×            | 0.458              | 1.07×            | 0.180                 | 0.42×            |
| Test 2: select small row | 0.285              | 0.265                         | 0.93×            | 0.391              | 1.37×            | 0.062                 | 0.22×            |
| Test 3: update small row | 0.259              | 0.300                         | 1.16×            | 0.435              | 1.68×            | 0.076                 | 0.29×            |
| Test 4: delete small row | 0.408              | 0.411                         | 1.01×            | 1.255              | 3.08×            | 0.181                 | 0.44×            |
| Test 5: insert 1kb row   | 0.299              | 0.269                         | 0.90×            | 0.420              | 1.41×            | 0.151                 | 0.51×            |
| Test 6: select 1kb row   | 0.460              | 0.534                         | 1.16×            | 1.144              | 2.49×            | 0.093                 | 0.20×            |
| Test 7: update 1kb row   | 0.346              | 0.280                         | 0.81×            | 0.480              | 1.39×            | 0.072                 | 0.21×            |
| Test 8: delete 1kb row   | 0.499              | 0.442                         | 0.89×            | 0.961              | 1.93×            | 0.155                 | 0.31×            |
| Test 9: insert 10kb row  | 0.395              | 0.438                         | 1.11×            | 0.634              | 1.60×            | 0.229                 | 0.58×            |
| Test 10: select 10kb row | 0.446              | 0.506                         | 1.13×            | 0.855              | 1.92×            | 0.115                 | 0.26×            |
| Test 11: update 10kb row | 0.344              | 0.408                         | 1.19×            | 0.366              | 1.07×            | 0.125                 | 0.36×            |
| Test 12: delete 10kb row | 0.388              | 0.381                         | 0.98×            | 0.689              | 1.78×            | 0.153                 | 0.39×            |
