all ::
	echo "Not yet fully automated"

moedict-data/moedict-data/dict-revised.json :: checkout

checkout ::
	-git clone git://github.com/g0v/moedict-epub.git
	-git clone git://github.com/g0v/moedict-data.git

data :: moedict-data/dict-revised.json
	echo perl split.pl $<
	echo perl uni.pl $<
	echo perl pua.pl $<
