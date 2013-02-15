use strict;
use utf8;
use File::Slurp;
use FindBin '$Bin';
mkdir "raw";
mkdir "uni";
mkdir "pua";
<>;
local $/ = "\n\t},\n";
my %map = do {
    local $/;
    open my $fh, '<:utf8', (@ARGV ? $ARGV[0] : "$Bin/moedict-epub/sym-pua.txt") or die $!;
    map { split(/\s+/, $_, 2) } split(/\n/, <$fh>);
};
my $re = join '|', keys %map;
my $compat = join '|', map { substr($_, 1) } grep /^x/, keys %map;
while (<>) {
    s/[,\]]\s*$//;
    utf8::decode($_);
    next unless /"title": "([^"]+)"/;
    my $title = $1;
    if (/\{\[[a-f0-9]{4}\]\}/) {
        my $is_pua = /95ef|9769|fec6|8fa3|8ff0|9868|90fd|997b|99e3|9ad7|9afd/;
        next unless $is_pua;
        tr!\x{FF21}-\x{FF3A}\x{FF41}-\x{FF5A}!A-Za-z!;
        s!˙!．!g; # middle dot
        s< "\{\[ ($compat) \]\}" >
         < '"'.($map{"x$1"} || $map{$1}) . '"' >egx;
        s< \{\[ ($re) \]\} >< $map{$1} >egx;
        $title = $1 if /"title": "([^"]+)"/;

        # Explicit blacklist variants for now; use utf8<>big5 check later
        next if $title =~ /[勸奏寬慎曼璜簧聚負鬲咎它差慨沒瓜縣衷釵黃夢害廣旨獲稹考豪風欖蔻示衽垂華周善米契]/;

        unlink "pua/$title.json";
        write_file("pua/$title.json" => {binmode => ':utf8'} => $_);
        warn "Found pua/$title.json\n";
    }
}
