import { DictionaryPage } from "./DictionaryPage";

interface DictionaryProps {
  word?: string;
  idx?: number;
}

export function DictionaryC({ word, idx }: DictionaryProps) {
  return <DictionaryPage word={word} lang="c" idx={idx} />;
}
