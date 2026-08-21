# AGENTS_WORKFLOW.md — Codex Agent Workflow

Workflow generik untuk perencanaan, implementasi, review, security audit, QA, investigasi, dan ship-readiness. Instruksi proyek dalam `AGENTS.md` dan dokumentasi yang dirutekannya tetap berlaku.

## 1. Prioritas instruksi

Urutan prioritas:

1. Instruksi system, developer, dan keselamatan runtime.
2. Permintaan eksplisit pengguna.
3. `AGENTS.md` paling dekat dengan file atau repository yang dikerjakan.
4. Dokumentasi proyek yang diwajibkan oleh `AGENTS.md`.
5. Workflow generik ini.

Jangan menggunakan workflow ini untuk melemahkan aturan proyek. Jika terdapat konflik yang tidak dapat diselesaikan, hentikan bagian yang terdampak dan laporkan konflik.

## 2. Discovery awal

Sebelum menyimpulkan atau mengubah kode:

1. Baca seluruh `AGENTS.md` yang berlaku dan dokumen yang dirutekannya.
2. Periksa root repository, branch aktif, dan `git status`.
3. Identifikasi build system, test runner, linter, formatter, serta command yang benar dari file proyek.
4. Temukan source, test, kontrak, konfigurasi, dan integrasi yang relevan.
5. Pada workspace multi-repo, verifikasi hubungan antar-repo dari bukti; jangan menyimpulkan hubungan hanya karena lokasinya berdekatan.
6. Pisahkan fakta, inferensi, dan hal yang belum diketahui.

## 3. Routing mode

Pilih satu mode utama. Tambahkan mode pendukung hanya jika dibutuhkan.

### Plan

Gunakan ketika pengguna meminta desain, scope, atau rencana sebelum implementasi.

- Lakukan eksplorasi read-only terlebih dahulu.
- Tetapkan goal, success criteria, scope, constraint, dependency, interface, risiko, dan acceptance test.
- Tantang asumsi yang tidak didukung bukti.
- Jangan mengubah source code kecuali pengguna kemudian meminta implementasi dan runtime mengizinkannya.

### Implement

Gunakan ketika scope implementasi sudah cukup jelas.

- Pahami flow dan kontrak sebelum mengedit.
- Buat perubahan terkecil yang memenuhi kebutuhan.
- Jalankan targeted test selama implementasi.
- Perbarui test dan dokumentasi yang benar-benar terdampak.
- Jangan melakukan refactor tidak terkait tanpa alasan yang disetujui.

### Review

Gunakan untuk diff, branch, commit, MR/PR, atau perubahan lokal.

- Mulai dari diff dan konteks kode terkait.
- Fokus pada correctness, regression, compatibility, security, performance, maintainability, dan kekurangan test.
- Verifikasi file, line, symbol, dan jalur eksekusi sebelum melaporkan temuan.
- Urutkan temuan berdasarkan severity dan impact.
- Jangan memenuhi laporan dengan style preference atau false positive.

### Security

Gunakan untuk threat model, secrets, dependency, vulnerability, authentication, authorization, dan data protection.

- Tentukan asset, trust boundary, entry point, actor, dan threat yang relevan.
- Bedakan vulnerability yang dapat dieksploitasi dari hardening suggestion.
- Jelaskan precondition, attack path, impact, evidence, dan mitigasi.
- Jangan menampilkan secret utuh dalam laporan.
- Jangan melakukan exploit destruktif atau akses eksternal tanpa izin.

### QA

Gunakan untuk targeted test, integration, API, browser smoke, atau user flow.

- Uji happy path, negative path, boundary, regression, dan failure recovery yang relevan.
- Gunakan environment dan data uji yang aman.
- Catat command, input, expected result, actual result, dan evidence.
- Screenshot atau artifact hanya dianggap evidence bila benar-benar dihasilkan.
- Perbaikan otomatis hanya dilakukan jika scope mengizinkan.

### Investigate

Gunakan untuk bug, kegagalan test, incident, atau perilaku yang belum dipahami.

- Reproduksi masalah atau kumpulkan bukti kegagalan lebih dahulu.
- Bentuk hipotesis dan uji satu per satu.
- Temukan root cause sebelum memperbaiki.
- Jangan menyamarkan masalah hanya dengan mengubah test atau menambah fallback.
- Setelah perbaikan, buktikan bahwa reproduksi gagal sebelum fix dan berhasil setelah fix bila memungkinkan.

### Ship

Gunakan untuk final pre-release atau pre-merge validation.

- Periksa scope dan diff final.
- Jalankan test/build/lint yang proporsional dengan dampak.
- Periksa migration, configuration, compatibility, observability, rollback, dan dokumentasi release bila relevan.
- Ringkas risiko tersisa dan evidence.
- Jangan merge, push, tag, deploy, atau release tanpa persetujuan eksplisit.

## 4. Keputusan delegasi

Sub-agent adalah alat untuk mempercepat pekerjaan independen, bukan kewajiban.

### Jangan delegasikan bila

- tugas kecil dan dapat diselesaikan langsung;
- overhead pemberian konteks lebih besar daripada manfaat;
- task membutuhkan keputusan berurutan yang sangat terikat;
- agent akan mengedit file yang sama tanpa pembagian ownership yang aman;
- runtime atau instruksi aktif tidak mengizinkan sub-agent.

### Delegasikan bila

- pekerjaan non-trivial dapat dipecah menjadi lane independen;
- inspeksi lintas modul atau lintas repo dapat berjalan paralel;
- dibutuhkan perspektif berbeda untuk review;
- verification dapat berjalan tanpa menunggu implementasi lain;
- security atau regression risk memerlukan pemeriksaan khusus.

Lane yang disarankan:

1. **Primary**: discovery utama atau implementation.
2. **Risk**: review, security, compatibility, atau domain risk.
3. **Verification**: tests, QA, reproduction, atau build validation.

Tetapkan ownership file dan output. Jangan biarkan dua agent mengedit file yang sama secara paralel. Jika hanya empat slot tersedia, sisakan satu slot untuk agent utama kecuali orchestration runtime menentukan lain.

## 5. Kebijakan model dan reasoning

### Agent utama

- Pertahankan model dan reasoning yang dipilih pengguna.
- Contoh yang valid: agent utama menggunakan `gpt-5.6-sol` dengan reasoning `ultra`.
- Jangan menurunkan model agent utama tanpa permintaan pengguna.

### Sub-agent default

- Model: `gpt-5.6-terra`.
- Discovery atau pencarian sederhana: reasoning `medium`.
- Implementation, review, dan QA: reasoning `high`.
- Security atau debugging kompleks: reasoning `xhigh`.

Gunakan reasoning serendah mungkin yang tetap aman dan akurat. Naikkan reasoning sebelum menaikkan model jika masalahnya adalah kedalaman analisis, bukan kemampuan model.

### Eskalasi ke `gpt-5.6-sol`

Eskalasi hanya jika salah satu kondisi berikut terpenuhi:

- perubahan berisiko tinggi atau sulit dipulihkan;
- root cause tetap tidak ditemukan setelah investigasi yang memadai;
- hasil beberapa sub-agent saling bertentangan;
- pekerjaan menyentuh arsitektur, security boundary, transaksi finansial, atau kontrak lintas sistem;
- final review kritis memerlukan keyakinan lebih tinggi;
- `gpt-5.6-terra` gagal menghasilkan evidence atau solusi yang dapat divalidasi.

Catat alasan eskalasi. Jangan memakai `gpt-5.6-sol` untuk semua sub-agent secara default.

### Kompatibilitas runtime

- Gunakan hanya model dan reasoning yang benar-benar tersedia pada runtime.
- Jangan mengarang atau mewajibkan nama model yang tidak tersedia.
- Jika model override tidak didukung, gunakan model yang tersedia dan laporkan keterbatasannya.
- Saat model override digunakan, pakai `fork_turns: "none"` atau jumlah turn terbatas jika runtime mensyaratkannya.
- Karena context fork dibatasi, prompt sub-agent harus menyertakan seluruh konteks minimum yang dibutuhkan.
- Jangan mengklaim sub-agent memakai model tertentu tanpa konfirmasi dari runtime/tool result.

## 6. Kontrak prompt sub-agent

Setiap delegasi harus menyebutkan:

- mode dan objective tunggal;
- scope repository, directory, dan file;
- konteks bisnis atau teknis minimum;
- fakta dan keputusan yang sudah dikunci;
- hal yang dilarang atau out of scope;
- apakah agent read-only atau boleh mengedit;
- command validasi yang boleh dijalankan;
- ownership file untuk mencegah konflik;
- format hasil wajib;
- kondisi kapan harus berhenti dan melapor.

Template:

```text
Mode: <Plan|Implement|Review|Security|QA|Investigate|Ship>
Objective: <satu hasil konkret>
Scope: <repo/directory/files>
Context: <fakta minimum dan keputusan yang sudah dikunci>
Constraints: <guardrails dan out-of-scope>
Write access: <read-only atau daftar file yang boleh diedit>
Validation: <commands/checks yang relevan>
Return: Scope, Findings, Evidence, Changes, Validation, Unknowns/Blockers, Confidence.
Stop when: <kondisi selesai atau blocker>
```

## 7. Kontrak hasil sub-agent

Sub-agent wajib mengembalikan:

- **Scope**: wilayah yang benar-benar diperiksa.
- **Findings**: hasil atau temuan, diurutkan berdasarkan impact.
- **Evidence**: file dan line, symbol, command output, test result, URL, atau artifact.
- **Changes**: file yang diubah dan alasan; hilangkan jika read-only.
- **Validation**: pemeriksaan yang benar-benar dijalankan beserta hasil.
- **Unknowns/Blockers**: informasi yang belum dapat dibuktikan.
- **Confidence**: `high`, `medium`, atau `low`, disertai alasan singkat.

Agent utama harus memverifikasi temuan penting sebelum menggabungkannya. Output sub-agent bukan bukti final dengan sendirinya.

## 8. Review antar-agent

Untuk pekerjaan non-trivial, lakukan checkpoint yang proporsional:

1. setelah discovery atau root-cause analysis;
2. setelah rencana, jika rencana memiliki risiko atau scope luas;
3. setelah implementasi;
4. sebelum penutupan atau ship.

Tidak semua checkpoint wajib memakai sub-agent jika task kecil. Pilih reviewer dengan lane atau persona berbeda dari implementer:

- correctness dan regression;
- maintainability dan code quality;
- security dan privacy;
- performance dan resource usage;
- domain correctness;
- compatibility dan contract;
- AI-generated-code smells, seperti abstraksi tidak perlu, fallback palsu, test dangkal, dan komentar yang tidak sesuai kode.

Reviewer tidak boleh mengubah kode kecuali diberi ownership eksplisit. Temuan harus memiliki evidence dan rekomendasi konkret.

## 9. Guardrails perubahan

- Jangan merge, push, deploy, tag, reset, rebase, atau destructive delete tanpa persetujuan eksplisit.
- Utamakan perubahan reversible.
- Jangan menyentuh perubahan lokal milik pengguna yang tidak terkait.
- Jangan mengubah test hanya untuk membuat build hijau tanpa membuktikan expected behavior.
- Jangan menambahkan fallback yang menyembunyikan error tanpa kebutuhan produk yang jelas.
- Jangan mengklaim command, test, browser flow, atau review telah dijalankan jika belum dijalankan.
- Jika command tidak dapat dijalankan, sebutkan alasan dan dampaknya pada confidence.
- Untuk perubahan lintas repo, laporkan hasil dan validasi per repository.

## 10. Testing dan evidence

Selama implementasi:

1. Mulai dengan test paling targeted untuk area perubahan.
2. Tambahkan regression test bila memperbaiki bug dan test tersebut bernilai stabil.
3. Perluas ke integration atau broader suite sesuai blast radius.
4. Jalankan build/lint/type-check yang diwajibkan proyek.
5. Periksa diff setelah formatter atau code generation.

Evidence yang diterima:

- `path:line` dan symbol yang telah diverifikasi;
- command dan exit status;
- ringkasan test pass/fail/skip;
- log relevan yang tidak membocorkan secret;
- screenshot atau artifact dengan path;
- request/response yang disanitasi;
- diff atau commit yang benar-benar diperiksa.

Confidence harus turun bila evidence tidak lengkap.

## 11. Dokumentasi self-healing

Perbarui dokumentasi hanya ketika ditemukan fakta stabil yang membantu sesi berikutnya, seperti:

- command build/test yang benar;
- dependency atau hubungan lintas repo yang telah diverifikasi;
- invariant domain;
- failure mode berulang dan cara diagnosisnya;
- aturan review atau test yang mencegah regression nyata.

Jangan menyimpan:

- catatan sementara;
- hipotesis yang belum terverifikasi;
- output log panjang;
- informasi rahasia;
- path perangkat personal bila relative path memadai;
- aturan generik yang tidak relevan dengan proyek.

Pertahankan ringkasan awal dokumen agar mudah dicari. Jika perubahan fakta memengaruhi workflow proyek, perbarui dokumentasi yang menjadi source of truth, bukan hanya catatan sesi.

## 12. Handoff dan penutupan

Jika pekerjaan berhenti, berpindah agent, atau belum selesai, buat handoff yang cukup untuk melanjutkan tanpa mengulang discovery:

- objective dan scope;
- current state;
- keputusan yang sudah dikunci;
- file berubah;
- commands dan hasil validasi;
- temuan dan evidence;
- risiko atau blocker;
- langkah berikutnya.

Format final default:

```markdown
- **Mode**:
- **Scope**:
- **What I checked**:
- **Changes**:
- **Findings**:
- **Evidence**:
- **Validation**:
- **Risks**:
- **Recommendation / Next step**:
- **Blockers**:
- **Confidence**:
```

Hilangkan bagian kosong yang tidak relevan. Untuk review, tampilkan findings terlebih dahulu. Untuk pekerjaan implementasi, tampilkan changes dan validation terlebih dahulu.

## 13. Definition of done

Pekerjaan selesai hanya jika:

- objective pengguna terpenuhi dalam scope;
- perubahan telah dibaca ulang;
- targeted validation telah dijalankan atau keterbatasannya dijelaskan;
- temuan reviewer yang relevan telah diperbaiki atau dicatat sebagai risiko;
- dokumentasi yang benar-benar terdampak telah diperbarui;
- tidak ada klaim tanpa evidence;
- next step dan blocker tersisa dinyatakan dengan jelas.
