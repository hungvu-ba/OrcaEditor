/**
 * US-15.7: xếp hạng các nhóm kết quả (1 nhóm = 1 file) của tìm xuyên file theo
 * mức độ LIÊN QUAN tới từ khoá — thay vì giữ nguyên thứ tự `findFiles` trả về.
 *
 * Hàm THUẦN (không DOM/Node/vscode API) — cùng khuôn với text-match.ts, để
 * unit test chạy được không cần mock môi trường extension host.
 *
 * Công thức đã chốt 2026-07-13 (xem Requirement - 15 Cross-File Search
 * Enhancements.md, US-15.7):
 *
 *   idf(keyword)        = log(totalCandidateFiles / filesContainingKeyword), floor tại 1
 *   matchSignal(match)  = headingBoost + definitionBoost + positionBoost
 *   fileNameBoost(file) = +2 glossary/readme/definition/spec, -2 test/changelog/history, else 0
 *   fileScore(file)     = idf * (max(matchSignal mọi match trong file) + log2(1 + totalInFile))
 *                         + fileNameBoost
 *
 * `filesContainingKeyword` = `groups.length` (số file THỰC TẾ tìm được match,
 * bị cap ở CROSS_FILE_SEARCH_MAX_GROUPS theo GĐ1) — hệ quả chấp nhận được: khi
 * ≥5 file cùng khớp, idf gần như không đổi giữa các từ khoá khác nhau (luôn
 * dùng mẫu số 5). Đây là đánh đổi của chính cơ chế cap-theo-file, không phải
 * lỗi của công thức — tính rarity chính xác tuyệt đối sẽ cần quét toàn bộ
 * workspace không cap, ngược lại tinh thần hiệu năng của D2 điểm 4.
 */

import type { CrossFileMatch, CrossFileMatchGroup } from './messages';

/** Dòng heading Markdown (# .. ######), khớp trên `lineText` đã trim. Nhóm bắt: phần chữ sau dấu #. */
const HEADING_LINE_RE = /^#{1,6}\s+(.*)$/;

/** "Term: giải thích..." — cụm đứng đầu dòng, ngắn (tránh khớp nhầm câu văn thường có dấu ":"). */
const DEFINITION_TERM_COLON_RE = /^[^:]{1,80}:\s/;
/** "**Term** là...", "*Term* is a...", "Term refers to..." — thuật ngữ in đậm/nghiêng đứng đầu dòng kèm động từ định nghĩa. */
const DEFINITION_BOLD_TERM_RE = /^\*{1,2}[^*]{1,80}\*{1,2}\s*(là|is\s+a\b|refers?\s+to\b)/i;
/** Cụm từ định nghĩa xuất hiện bất kỳ đâu trong dòng. */
const DEFINITION_KEYWORD_RE = /định nghĩa|nghĩa là|refers?\s+to|is\s+a\b/i;

/** Chuẩn hoá text heading/keyword để so "gần đúng": hạ thường, bỏ ký tự nhấn mạnh markdown, gộp khoảng trắng, trim dấu câu cuối. */
function normalizeForHeadingCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:.\s]+$/, '');
}

/**
 * Heading có "trùng gần đúng" keyword không — heading về cơ bản CHÍNH LÀ thuật
 * ngữ đó (cho phép dư một ít chữ, vd số thứ tự/dấu ":"), không chỉ nhắc tới nó
 * giữa một tiêu đề dài hơn (trường hợp đó là headingBoost +3, không phải +5).
 */
function headingApproxEqualsKeyword(headingText: string, keyword: string): boolean {
  const heading = normalizeForHeadingCompare(headingText);
  const kw = normalizeForHeadingCompare(keyword);
  if (!heading || !kw) {
    return false;
  }
  return heading === kw || (heading.includes(kw) && heading.length <= kw.length + 6);
}

/** K: +5 heading ~trùng đúng keyword, +3 match nằm trong heading nhưng không trùng gần đúng, 0 nếu match không nằm trong heading. */
function headingBoost(match: CrossFileMatch, keyword: string): number {
  const heading = HEADING_LINE_RE.exec(match.lineText);
  if (!heading) {
    return 0;
  }
  return headingApproxEqualsKeyword(heading[1], keyword) ? 5 : 3;
}

/** L: +4 nếu dòng chứa match khớp 1 trong các khuôn mẫu "dòng định nghĩa". */
function definitionBoost(match: CrossFileMatch): number {
  const line = match.lineText;
  const isDefinition =
    DEFINITION_TERM_COLON_RE.test(line) || DEFINITION_BOLD_TERM_RE.test(line) || DEFINITION_KEYWORD_RE.test(line);
  return isDefinition ? 4 : 0;
}

/** M: càng gần đầu file càng cao, cap [0, 1]. fileLength <= 0 (file rỗng, không nên xảy ra vì đã có match) ⇒ 0. */
function positionBoost(match: CrossFileMatch, fileLength: number): number {
  if (fileLength <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, 1 - match.charOffset / fileLength));
}

function matchSignal(match: CrossFileMatch, keyword: string, fileLength: number): number {
  return headingBoost(match, keyword) + definitionBoost(match) + positionBoost(match, fileLength);
}

/** N: path khớp glossary/readme/definition/spec ⇒ +2 (tài liệu tra cứu); test/changelog/history ⇒ -2 (ít khi là nơi tra định nghĩa). */
const FILE_NAME_BOOST_POSITIVE_RE = /glossary|readme|definition|spec/i;
const FILE_NAME_BOOST_NEGATIVE_RE = /test|changelog|history/i;

function fileNameBoost(relativePath: string): number {
  if (FILE_NAME_BOOST_POSITIVE_RE.test(relativePath)) {
    return 2;
  }
  if (FILE_NAME_BOOST_NEGATIVE_RE.test(relativePath)) {
    return -2;
  }
  return 0;
}

/** O: idf — từ khoá càng hiếm (ít file chứa nó) trong tập ứng viên, hệ số nhân càng cao. Floor tại 1. */
function idf(totalCandidateFiles: number, filesContainingKeyword: number): number {
  if (totalCandidateFiles <= 0 || filesContainingKeyword <= 0) {
    return 1;
  }
  return Math.max(1, Math.log(totalCandidateFiles / filesContainingKeyword));
}

/** P: lấy match TỐT NHẤT làm bằng chứng chính + cộng thêm giảm dần theo số lượng match (log2), tránh 1 file 50 match thắng tuyệt đối 1 file 2 match có heading khớp. */
function fileScore(group: CrossFileMatchGroup, keyword: string, idfValue: number): number {
  const bestSignal = group.matches.reduce((max, m) => Math.max(max, matchSignal(m, keyword, group.fileLength)), 0);
  return idfValue * (bestSignal + Math.log2(1 + group.totalInFile)) + fileNameBoost(group.relativePath);
}

/**
 * Trả về BẢN SAO của `groups`, sort giảm dần theo `fileScore` — không mutate
 * mảng/phần tử gốc. `totalCandidateFiles` = tổng số file đủ điều kiện quét nội
 * dung (uris.length của findFiles trong crossFileSearch), dùng làm mẫu số idf.
 */
export function rankFileGroups(
  groups: readonly CrossFileMatchGroup[],
  keyword: string,
  totalCandidateFiles: number
): CrossFileMatchGroup[] {
  const idfValue = idf(totalCandidateFiles, groups.length);
  // Tính điểm MỘT lần mỗi group rồi mới sort — trước đây fileScore (bản thân là
  // một reduce trên mọi match) bị gọi lại ở từng lần so sánh của .sort(), thành
  // O(n log n) lượt reduce thay vì O(n).
  const scored = groups.map((group) => ({ group, score: fileScore(group, keyword, idfValue) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.group);
}
