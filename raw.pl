use File::Slurp;
mkdir "raw";
<>;
local $/ = "\n\t},\n";
while (<>) {
    s/[,\]]\s*$//;
    next unless /"title": "([^"]+)"/;
    my $title = $1;
    my $file = "raw/$title.json";
    write_file($file => $_);
    next unless $title =~ s/\(.*//;
    $file = "raw/$title.json";
    write_file($file => $_);
}
