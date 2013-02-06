use File::Slurp;
mkdir "raw";
<>;
local $/ = "\n\t}, \n";
while (<>) {
    chop; chop; chop;
    s/^\t//mg;
    next unless /"title": "([^"]+)"/;
    my $title = $1;
    write_file("raw/$title.json" => $_);
}
