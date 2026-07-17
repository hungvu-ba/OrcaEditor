## Phase 2 execCommandbugs

2.  Enter trong bullet list bị lỗi serialize (backslash "" trên item rỗng + tách list thành 2 block bằng dòng trống thừa) — phân tích + hướng fix: bug 0717 round2.md
3.  Indent/outdent cần thực hiện build lại drag handler. — phân tích: bug 0717 round3.md, Bug #1
4.  Vị trí li bị sai sau outdent 1 dòng trắng. Charlie bị thụt lùi hơn so với Alpha như hình:<img src="assets/bug-list-pasted-image-1784295858300-c7154953.png" alt="" width="1213"> — phân tích: bug 0717 round3.md, Bug #2
5.  Enter ở bullet tạo ra dòng trắng thừa và dấu "\\": <img src="assets/bug-list-pasted-image-1784295960107-ec3c3f2a.png" alt="" width="837"> — phân tích: bug 0717 round3.md, Bug #2
6.  TC2.2b tạo dòng trắng thừa phía trước và đặt sai vị trí của bullet: <img src="assets/bug-list-pasted-image-1784296098983-02990c4c.png" alt="" width="869"> — phân tích: bug 0717 round3.md, Bug #3
7.  TC2.2c: Lỗi giống bug #4 <img src="assets/bug-list-pasted-image-1784296181399-4fe75c1c.png" alt="" width="907"> — phân tích: bug 0717 round3.md, Bug #4
8.  TC2.3b, TC2.4b, TC2.7b: lỗi, tạo thành 2 dòng trống:<img src="assets/bug-list-pasted-image-1784296522979-c519109c.png" alt="" width="1157"> — phân tích: bug 0717 round3.md, Bug #5 (đã có fix chưa commit trong working tree, cần verify + test)
9.  TC2.3d, TC2.4d: Create an additional "\\" a the end<img src="assets/bug-list-pasted-image-1784296695455-43394607.png" alt="" width="877"> — phân tích: bug 0717 round3.md, Bug #6
10.  TC2.5C: Bấm convert thành H2 nhưng bị dính text dòng dưới. có vẻ do 3 dấu gạch ở dòng dưới. — phân tích: bug 0717 round3.md, Bug #7
11.  <img src="assets/bug-list-pasted-image-1784297131667-d195114e.png" alt="" width="1194"><img src="assets/bug-list-pasted-image-1784297080383-ce301487.png" alt="" width="1253"> — phân tích: bug 0717 round3.md, Bug #7 (cùng bug với #10, before/after)
12.  TC2.6b: quote rồi cách tạo ra quote với dấu \\<img src="assets/bug-list-pasted-image-1784297306760-81e83b19.png" alt="" width="858"> — phân tích: bug 0717 round3.md, Bug #8 (ảnh khớp TC2.6a, không phải TC2.6b — xem lưu ý nhãn trong file)
13.  TC2.6b: quote ở dòng trắng trên dòng --- <img src="assets/bug-list-pasted-image-1784297384729-59c9b426.png" alt="" width="1196"><img src="assets/bug-list-pasted-image-1784297413225-629cdf37.png" alt="" width="885"> — phân tích: bug 0717 round3.md, Bug #9
14.  TC2.7C: Undo ở TC2.7C làm undo cả phần 2.7b đã hoàn thành trước đó lâu<img src="assets/bug-list-pasted-image-1784297650511-86b64fa2.png" alt="" width="569"> — phân tích: bug 0717 round3.md, Bug #11 — ✅ Đã fix (2026-07-17, spec-11): Task List qua table/pre/blockquote/heading tách list quanh atom qua `commitListOpDirect` (1 undo step), bỏ native execCommand.
15.  Gõ `>` trên đoạn văn RỖNG (bất kỳ, không cần `---`) làm text lọt ra ngoài blockquote rỗng (`Quoted line<blockquote><p></p></blockquote>` → lưu ra "Quoted"). Phát hiện khi verify Bug #9; cùng họ empty-blockquote với Bug #8. — phân tích: bug 0717 round3.md, Bug #12

## Nhóm undo granularity/chronology

✅ Đã fix (2026-07-17): 4 test là fixture cũ (marker `*` + hard-break `\` từ US-18.4b), không phải lỗi app — 10/10 pass.

(4 webview test đang fail, thuộc phần execcommand verb-replacement đang làm dở):

3.  Gõ chữ rồi bấm Bullet trong cửa sổ debounce phải commit 2 edit theo đúng thứ tự thời gian — hiện fail. Test: [undo-chronology.spec.ts:29](webview/undo-chronology.spec.ts#L29) — phân tích: bug 0717 round3.md, Bug #10
4.  Bấm Bullet rồi gõ chữ: edit bullet phải post NGAY, trước edit gõ — hiện fail. Test: [undo-chronology.spec.ts:54](webview/undo-chronology.spec.ts#L54) — phân tích: bug 0717 round3.md, Bug #10
5.  Word-boundary flush phải chạy cả khi space đến qua inputType không phải insertText (gõ composed/IME) — hiện fail. Test: [undo-granularity.spec.ts:51](webview/undo-granularity.spec.ts#L51) — phân tích: bug 0717 round3.md, Bug #10
6.  bug 0717b: các từ composed gõ liên tiếp không nghỉ phải mỗi từ một checkpoint undo riêng — hiện bị gộp thành một và editText dính "" ở đầu. Test: [undo-granularity.spec.ts:81](webview/undo-granularity.spec.ts#L81) — phân tích: bug 0717 round3.md, Bug #10
