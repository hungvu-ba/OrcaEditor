/**
 * Chuẩn bị DOM trước khi serialize (HTML → Markdown): chuẩn hóa list do
 * contentEditable/Chromium sinh sai, flatten list trong ô bảng đơn giản, đổi
 * HTML comment thành placeholder, chuẩn hóa NBSP. Cùng vài tiện ích DOM portable
 * cho bảng. Chạy được cả trên Node/domino cho round-trip test.
 */

/**
 * Chuẩn bị DOM trước khi serialize:
 *  - HTML comment → placeholder element (turndown bỏ qua comment node),
 *    rule 'mdComment' sẽ chuyển ngược thành <!-- ... -->.
 *  - List phẳng trong ô bảng "đơn giản" → các dòng "- x" nối bằng <br> để giữ
 *    bảng ở dạng pipe (Markdown thuần). Bảng có list phân cấp được để nguyên và
 *    serialize cả khối dưới dạng HTML (xem rule complexTableAsHtml).
 *  - NBSP do contentEditable chèn → space thường (trừ trong pre/code),
 *    gộp luôn chuỗi space liên tiếp trong cùng text node.
 */
export function prepareDomForSerialize(root: Element, doc: Document): void {
  const comments: Comment[] = [];
  collectComments(root, comments);
  for (const comment of comments) {
    const span = doc.createElement('span');
    span.setAttribute('data-md-comment', comment.data);
    // Nội dung giả để turndown không coi placeholder là node rỗng
    // (node rỗng làm mất khoảng trắng liền kề); rule mdComment bỏ qua content.
    span.textContent = 'x';
    comment.parentNode?.replaceChild(span, comment);
  }
  normalizeListDom(root);
  dropEmptyNestedSublists(root);
  flattenSimpleTableCellLists(root, doc);
  normalizeNbsp(root);
}

/** Media/void content that makes a list item non-empty even with no text. */
const NESTED_EMPTY_MEDIA_SELECTOR = 'img, input, video, audio, iframe, picture, svg, hr';

/**
 * Drop a NESTED sublist whose every <li> is empty (no text, no media — only a
 * <br> caret placeholder or nothing). A truly-empty child bullet directly under
 * a parent's text line has no faithful CommonMark serialization: with a `-`
 * bullet marker it serializes as "parentText\n    -", and a lone `-` line under
 * a paragraph is a SETEXT H2 underline — so re-parsing turns the parent's text
 * into a heading (reported: "Undo khi indent ở TC2.2c… - dưới Alpha/Bravo bị
 * nhận diện thành heading"). turndown already drops a nested sublist whose <li>
 * has ZERO children (the whole all-blank <ul> is isBlank), but a <li><br></li>
 * is "non-blank" to turndown (a <br> is a void element), so its sublist
 * survives and emits the trap. This unifies the two paths: an all-blank nested
 * sublist is transient editing state (a freshly Tab-indented empty item never
 * typed into), not document content, so it is removed before serialize — same
 * "blank line in a list is spacing, not content" stance as list-ops' computeToList.
 *
 * TOP-LEVEL empty items are left untouched (they serialize as a safe "-" bullet
 * on their own line, not a setext underline, and must round-trip — see
 * test/roundtrip/lists.ts). A nested sublist that mixes blank and non-blank
 * items is also left untouched: its blank items are sibling bullets, not a
 * setext trap.
 */
function dropEmptyNestedSublists(root: Element): void {
  const isBlankItem = (li: Element): boolean =>
    (li.textContent ?? '').trim() === '' && !li.querySelector(NESTED_EMPTY_MEDIA_SELECTOR);
  for (const list of Array.from(root.querySelectorAll('ul ul, ul ol, ol ul, ol ol'))) {
    const items = Array.from(list.children).filter((c) => c.nodeName === 'LI');
    if (items.length > 0 && items.every(isBlankItem)) {
      list.remove();
    }
  }
}

/**
 * execCommand('indent' | 'outdent') của Chromium sinh cấu trúc list KHÔNG hợp lệ
 * (trình duyệt vẫn render đúng theo số tầng ul/ol, nhưng turndown và bộ phát hiện
 * "list phân cấp" đọc sai):
 *  - indent:  <ul><li>x</li><ul>…</ul></ul>   (danh sách nằm ngay trong danh sách)
 *  - outdent: <ul><li>a<li>b</li></li></ul>   (li nằm ngay trong li)
 * Cùng một lỗi (thuật toán merge/split list của Chromium) còn lộ ra khi XOÁ hoặc
 * CẮT (Cmd/Ctrl+X) một vùng chọn đè lên ranh giới giữa text của một mục và danh
 * sách con lồng ngay trong mục đó: Chrome tách nhầm danh sách con ra một <li>
 * riêng đứng SAU <li> chứa text — nhìn giống hệt bullet con "nhảy" xuống dòng
 * dưới — xem findOrphanNestedListPair. execCommand('undo') sau đó cũng không tự
 * sửa được vì lịch sử undo chỉ phát lại đúng các bước biến đổi DOM đã sai ngay
 * từ bước xoá gốc, không hiểu ngữ nghĩa "list phân cấp" để phục hồi đúng cây.
 * Chuẩn hóa về cây lồng nhau hợp lệ, khớp đúng mức thụt lề người dùng nhìn thấy,
 * trước khi phát hiện độ phức tạp và flatten.
 *
 * HLR 22 Phase 3 (guarded patch-removal) audit outcome — Rules A/B are NOT dead
 * after the Phase 2 verb replacement and MUST stay. The primary indent/outdent
 * and bullet/number toolbar paths now build clean `li > ul` via the list-ops
 * primitive, but the narrow execCommand fallbacks intentionally kept for the
 * uncharacterized cases still emit these malformed shapes on the live DOM and
 * reach this normalizer through the serialize clone:
 *  - Rule B `ul>ul` / Rule A `li>li`: `execCommand('indent' | 'outdent')` in the
 *    main.ts Tab handler (non-collapsed selection, or top-level/first `<li>` where
 *    computeIndent/computeOutdent return null).
 *  - Rule B `ul>ul`: `execCommand('insert{Un}orderedList')` in toolbar
 *    setBulletList/setNumberedList/toggleTaskItem (nested-sublist target → plan null).
 * Rule C additionally has delete/cut/undo as its own independent source (that path
 * self-heals live via fixOrphanNestedListItems, which runs Rule C only). Do not
 * delete any rule while those execCommand fallbacks exist.
 */
export function normalizeListDom(root: Element): void {
  const isList = (n: Node | null): boolean => !!n && (n.nodeName === 'UL' || n.nodeName === 'OL');
  let guard = 0;
  for (;;) {
    let changed = false;

    // Rule A: <li> chứa trực tiếp <li> → tách <li> con (và mọi node sau nó) ra
    // thành anh em ngay sau <li> cha (giữ nguyên thứ tự).
    for (const outer of Array.from(root.querySelectorAll('li'))) {
      const parent = outer.parentNode;
      if (!parent) {
        continue;
      }
      const boundary = Array.from(outer.childNodes).find((c) => c.nodeName === 'LI');
      if (!boundary) {
        continue;
      }
      const moved: Node[] = [];
      for (let n: Node | null = boundary; n; n = n.nextSibling) {
        moved.push(n);
      }
      const ref = outer.nextSibling;
      for (const n of moved) {
        parent.insertBefore(n, ref);
      }
      changed = true;
    }

    // Rule B: danh sách nằm ngay trong danh sách → đưa vào <li> liền trước (mục
    // mà nó thuộc về); nếu không có thì bọc trong một <li> mới.
    for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
      if (!isList(list.parentNode)) {
        continue;
      }
      const prev = list.previousElementSibling;
      if (prev && prev.nodeName === 'LI') {
        prev.appendChild(list);
      } else {
        const li = root.ownerDocument?.createElement('li');
        if (li && list.parentNode) {
          list.parentNode.insertBefore(li, list);
          li.appendChild(list);
        }
      }
      changed = true;
    }

    // Rule C: <li> chỉ chứa DUY NHẤT một danh sách con (không text/nội dung nào
    // khác) đứng ngay sau một <li> khác → danh sách con này thực ra thuộc về
    // <li> liền trước — gộp vào đó rồi bỏ <li> rỗng vừa tách ra (xem chú thích
    // ở đầu hàm).
    for (;;) {
      const pair = findOrphanNestedListPair(root);
      if (!pair) {
        break;
      }
      pair.prev.appendChild(pair.nested);
      pair.wrapper.remove();
      changed = true;
    }

    if (!changed || ++guard > 50) {
      break;
    }
  }
}

/**
 * Tìm một cặp (li liền trước, li chỉ chứa duy nhất một danh sách con) cần gộp —
 * dấu hiệu của lỗi Chromium tả ở normalizeListDom. Dùng chung cho cả chuẩn hóa
 * trên bản sao lúc serialize (normalizeListDom, thao tác DOM trần) lẫn sửa trực
 * tiếp trên DOM đang chỉnh sửa còn sống (main.ts, phải qua execCommand để không
 * phá lịch sử undo/redo gốc).
 */
export function findOrphanNestedListPair(
  root: Element
): { prev: Element; wrapper: Element; nested: Element } | null {
  for (const wrapper of Array.from(root.querySelectorAll('li'))) {
    const meaningful = Array.from(wrapper.childNodes).filter(
      (n) => !(n.nodeType === 3 /* TEXT_NODE */ && !(n.textContent ?? '').trim())
    );
    if (meaningful.length !== 1) {
      continue;
    }
    const nested = meaningful[0];
    if (nested.nodeName !== 'UL' && nested.nodeName !== 'OL') {
      continue;
    }
    const prev = wrapper.previousElementSibling;
    if (!prev || prev.nodeName !== 'LI') {
      continue;
    }
    return { prev, wrapper, nested: nested as Element };
  }
  return null;
}

/**
 * Cú pháp bảng GFM (pipe) mỗi ô nằm trên một dòng nên không biểu diễn được
 * list block. Chiến lược:
 *  - Ưu tiên giữ bảng ở dạng pipe.
 *  - Ô chỉ có list phẳng 1 cấp (hoặc xuống dòng) → chuyển thành các dòng
 *    "- x" / "1. x" nối bằng <br>: vẫn là bảng Markdown thuần, round-trip được.
 *  - Ô có list phân cấp (li lồng li) → bảng đó không thể là Markdown thuần;
 *    bỏ qua ở đây để rule complexTableAsHtml giữ nguyên cả bảng dưới dạng HTML.
 */
function flattenSimpleTableCellLists(root: Element, doc: Document): void {
  const tables = Array.from(root.querySelectorAll('table'));
  for (const table of tables) {
    if (tableNeedsHtmlSerialization(table)) {
      continue; // bảng phức tạp — giữ nguyên list để serialize dạng HTML
    }
    const lists = Array.from(table.querySelectorAll('td ul, td ol, th ul, th ol'));
    for (const list of lists) {
      flattenListToBrLines(list, doc);
    }
  }
}

/** Bảng cần serialize dạng HTML khi có ô chứa list phân cấp (li lồng trong li). */
export function tableNeedsHtmlSerialization(table: Element): boolean {
  return table.querySelector('td li li, th li li') != null;
}

/**
 * Thay <ul>/<ol> phẳng bằng chuỗi inline "- a<br>- b" (giữ nguyên định dạng
 * inline như **đậm**, *nghiêng*, link trong từng mục). Với <ol> giữ số bắt đầu.
 */
function flattenListToBrLines(list: Element, doc: Document): void {
  const ordered = list.nodeName === 'OL';
  const startAttr = parseInt(list.getAttribute('start') ?? '1', 10);
  const start = Number.isFinite(startAttr) ? startAttr : 1;
  const items = Array.from(list.children).filter((c) => c.nodeName === 'LI');
  const frag = doc.createDocumentFragment();
  items.forEach((li, i) => {
    if (frag.childNodes.length > 0) {
      frag.appendChild(doc.createElement('br'));
    }
    frag.appendChild(doc.createTextNode(ordered ? `${start + i}. ` : '- '));
    // Loose list: nội dung mục bị bọc trong <p> — lấy nội dung trong <p> để
    // không sinh block (block sẽ bị ép thành khoảng trắng, mất dòng).
    const source =
      li.children.length === 1 && li.firstElementChild?.nodeName === 'P'
        ? (li.firstElementChild as Element)
        : li;
    while (source.firstChild) {
      frag.appendChild(source.firstChild);
    }
  });
  // Ngăn cách với nội dung liền trước/sau trong cùng ô bằng <br>.
  if (list.previousSibling && list.previousSibling.nodeName !== 'BR') {
    frag.insertBefore(doc.createElement('br'), frag.firstChild);
  }
  if (list.nextSibling && list.nextSibling.nodeName !== 'BR') {
    frag.appendChild(doc.createElement('br'));
  }
  list.parentNode?.replaceChild(frag, list);
}

function normalizeNbsp(node: Node): void {
  if (node.nodeType === 1) {
    const name = (node as Element).nodeName;
    if (name === 'PRE' || name === 'CODE') {
      return;
    }
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      const text = child.nodeValue ?? '';
      if (text.includes('\u00A0')) {
        child.nodeValue = text.replace(/\u00A0/g, ' ').replace(/ {2,}/g, ' ');
      }
    } else {
      normalizeNbsp(child);
    }
  }
}

function collectComments(node: Node, out: Comment[]): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 8 /* COMMENT_NODE */) {
      out.push(child as Comment);
    } else {
      collectComments(child, out);
    }
  }
}

/**
 * Nếu cột đầu tiên của bảng là cột số thứ tự (mọi ô cột đầu ở tbody đều là số
 * nguyên) thì đánh số lại liên tục cả cột — dòng mới chèn vào (newRow, các ô
 * đang trống) sẽ nhận đúng số kế tiếp, các dòng phía sau tự dồn số. Giữ nguyên
 * số bắt đầu (1, 0 hay 5... tùy bảng). Dùng chung cho nút toolbar lẫn phím Tab
 * (mọi đường tạo dòng đều đi qua đây). Viết bằng DOM API portable để test được
 * trên Node (domino).
 */
export function fillSequenceColumn(table: Element, newRow: Element): boolean {
  const tbody = table.querySelector('tbody');
  if (!tbody) {
    return false;
  }
  const rows = Array.from(tbody.rows);
  const firstCellOf = (r: HTMLTableRowElement): Element | undefined => r.cells[0];
  const others = rows.filter((r) => r !== newRow);
  if (others.length === 0) {
    return false;
  }
  const values = others.map((r) => (firstCellOf(r)?.textContent ?? '').trim());
  if (!values.every((v) => /^\d+$/.test(v))) {
    return false;
  }
  // Số bắt đầu = số hiện tại của dòng đầu tiên (đã validate là số nguyên)
  let n = parseInt(values[0], 10);
  for (const r of rows) {
    const c = firstCellOf(r);
    if (!c) {
      continue;
    }
    const text = String(n);
    if ((c.textContent ?? '').trim() !== text) {
      c.textContent = text;
    }
    n++;
  }
  return true;
}
