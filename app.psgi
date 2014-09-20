#!/usr/bin/env perl
use 5.12.0;
use strict;
use Mojolicious::Lite;
hook before_dispatch => sub {
    my $h = shift()->res->headers;
    $h->header( 'Access-Control-Allow-Origin' => '*' );
    $h->header( 'Access-Control-Allow-Methods' => 'GET, PUT, POST, DELETE, OPTIONS' );
    $h->header( 'Access-Control-Max-Age' => 3600 );
    $h->header( 'Access-Control-Allow-Headers' => 'Content-Type, Authorization, X-Requested-With' );
};
sub done {
    my ($c, $status, $data) = @_;
    $c->respond_to( any => { data => $data // '', status => $status // 200 } );
}
options $_ => sub { done(shift()) } for ('', '*');

use Encode;
get '/SourceHanSansTW.ttf' => sub { my $c = shift;
    my $subset = $c->param('subset');
    Encode::_utf8_on($subset);
    #$subset =~ s/[\x00-\xff]//g;
    my %x;
    $x{$_}++ for split //, $subset;
my $id = int(rand() * 100000);
open my $fh, ">:utf8", "/tmp/$id.pe";
print $fh "$_\n" for qw[Open("./SourceHanSansTW-Regular.ttf") Select(0u3000)];
print $fh sprintf qq[SelectMore(0u%04x) #%s\n], $_, chr $_ for grep { $_ > 10000 } map ord, sort keys %x;
print $fh "$_\n" for qw[SelectInvert() Clear()];
print $fh qq[Generate("/tmp/$id.ttf")\n];
close $fh;
system("fontforge" => -script => "/tmp/$id.pe");
send_file($c, "/tmp/$id.ttf");
};

sub send_file {
    my ($c, $path, $content_type) = @_;
    $content_type ||= 'application/x-font-ttf';
    return done($c => 404) unless -f $path;
    my $asset = Mojo::Asset::File->new( path => $path );
    my $h = Mojo::Headers->new;
    $h->add('Content-Type' => $content_type);
    $h->add('Content-Length' => $asset->size);
    $h->add('Content-Disposition' => 'attachment; filename="SourceHanSansTW.ttf"');
    $c->res->content->headers($h);
    $c->res->content->asset($asset);
    return $c->rendered(200);
}

app->start;
