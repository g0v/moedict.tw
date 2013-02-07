all ::
	echo "Not yet fully automated"

moedict-data/moedict-data/dict-revised.json :: checkout

checkout ::
	-git clone git://github.com/g0v/moedict-epub.git
	-git clone git://github.com/g0v/moedict-data.git
	-git clone git://github.com/g0v/moedict-moedict-webkit.git

symlink ::
	-ln -s moedict-epub/fontforge/*.*f .
	-ln -s moedict-webkit/* .

data :: moedict-data/dict-revised.json
	echo perl raw.pl $<
	echo perl uni.pl $<
	echo perl pua.pl $<
