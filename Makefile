import ::
	curl -i -H "Content-Type: application/json" -X PUT -d @moedict-epub/dict-revised.pua.json http://127.0.0.1:3000/collections/entries

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
