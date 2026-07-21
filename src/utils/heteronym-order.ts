/**
 * Display-order-only heteronym reordering for TWBLG (lang='t') entries.
 *
 * g0v/moedict-webkit follow-up: sutian.moe.edu.tw's own 詞目查詢 (`/tshiau/`)
 * lists a word's REAL-headword heteronym before its 替字 (substitution
 * character) heteronym — e.g. 一's `it` reading (the real headword, 異用字
 * 壹) is listed before its `tsi̍t` reading (替字, real character 蜀,
 * 異用字 蜀). Our ptck pack stores heteronyms in `詞目總檔.csv`/sutian
 * `su/N` id order, which for 一 happens to be [tsi̍t(id=1), it(id=2)] —
 * the OPPOSITE of sutian's own real-headword-first convention. Sorting by
 * `_`/id is therefore wrong (id order does not track real-headword-first;
 * su/1 IS the 替 substitution page). The only reliable per-heteronym
 * signal is the `reading` field itself (文/白/俗/替 classification,
 * g0v/moedict-webkit#96/#233): a heteronym tagged 替 is a substitution
 * reading, not the real headword.
 *
 * This is a presentation-only reorder — no pack byte changes, no content
 * modification (CC BY-ND 3.0 TW covers the 教育部 definition text/facts,
 * untouched here; only the on-page ordering of already-published
 * heteronym sections changes). Every OTHER classification (文/白/俗 —
 * register variants of the real headword, not substitutions) must keep
 * its existing pack-order position: this is a narrow stable partition on
 * 替 specifically, not a general sort by reading-type.
 */

const SUBSTITUTION_READING_TYPE = "替";

/**
 * Stable partition: heteronyms whose `readingType(item)` is exactly "替"
 * move to the end, in their original relative order; every other
 * heteronym (文/白/俗/no classification) keeps its exact original
 * relative order at the front. Equivalent to a stable sort on the
 * boolean "is 替" key — never reorders within either group.
 */
export function sortHeteronymsBySubstitutionReading<T>(
  heteronyms: readonly T[],
  readingType: (item: T) => string,
): T[] {
  const primary: T[] = [];
  const substitution: T[] = [];
  for (const item of heteronyms) {
    if (readingType(item) === SUBSTITUTION_READING_TYPE) {
      substitution.push(item);
    } else {
      primary.push(item);
    }
  }
  return primary.length === 0 || substitution.length === 0
    ? heteronyms.slice()
    : [...primary, ...substitution];
}
