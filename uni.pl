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
    open my $fh, '<:utf8', (@ARGV ? $ARGV[0] : "$Bin/moedict-epub/sym.txt") or die $!;
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
        my $is_pua = /8ff0|9868|90fd|997b|99e3|9ad7|9afd/;
        tr!\x{FF21}-\x{FF3A}\x{FF41}-\x{FF5A}!A-Za-z!;
        s!˙!．!g; # middle dot
        s< "\{\[ ($compat) \]\}" >
         < '"'.($map{"x$1"} || $map{$1}) . '"' >egx;
        s< \{\[ ($re) \]\} >< $map{$1} >egx;
        $title = $1 if /"title": "([^"]+)"/;
        write_file("uni/$title.json" => {binmode => ':utf8'} => $_);
        if ($is_pua) {
            warn "PUA: uni/$title.json\n";
        }
        else {
            symlink "../uni/$title.json" => "pua/$title.json"
        }
    }
}
