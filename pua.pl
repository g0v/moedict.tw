use strict;
use utf8;
use File::Slurp;
use FindBin '$Bin';
mkdir "raw";
mkdir "uni";
mkdir "pua";
<>;
local $/ = "\n\t}, \n";
my %map = do {
    local $/;
    open my $fh, '<:utf8', (@ARGV ? $ARGV[0] : "$Bin/sym-pua.txt") or die $!;
    map { split(/\s+/, $_, 2) } split(/\n/, <$fh>);
};
my $re = join '|', keys %map;
my $compat = join '|', map { substr($_, 1) } grep /^x/, keys %map;
while (<>) {
    utf8::decode($_);
    chop; chop; chop;
    s/^\t//mg;
    next unless /"title": "([^"]+)"/;
    my $title = $1;
    if (/\{\[[a-f0-9]{4}\]\}/) {
        next unless /8ff0|9868|90fd|997b|99e3|9ad7|9afd/;
        tr!\x{FF21}-\x{FF3A}\x{FF41}-\x{FF5A}!A-Za-z!;
        s!['"「]\K｜!⼁!g; # 2F01 is the character
        s!｜!ㄧ!g; # This is the phonetic symbol
        s!˙!．!g; # middle dot
        s< "\{\[ ($compat) \]\}" >
         < '"'.($map{"x$1"} || $map{$1}) . '"' >egx;
        s< \{\[ ($re) \]\} >< $map{$1} >egx;
        $title = $1 if /"title": "([^"]+)"/;
        unlink "pua/$title.json";
        write_file("pua/$title.json" => {binmode => ':utf8'} => $_);
        warn "Found pua/$title.json\n";
    }
}
