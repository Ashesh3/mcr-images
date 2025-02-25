"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { CalendarIcon, Copy, Check } from "lucide-react";
import { useState, useEffect } from "react";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={copy}>
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      <span className="sr-only">Copy version</span>
    </Button>
  );
}

export default function Page() {
  const [azureImages, setAzureImages] = useState<{ name: string; tag: string }[]>([]);
  const [mcrImages, setMcrImages] = useState<
    { name: string; releases: { tag: string; created: string }[] }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api")
      .then((res) => res.json())
      .then((data) => {
        // Convert the azureImages object into an array.
        const azureImagesArray = Object.entries(data.azureImages).map(
          ([name, tag]) => ({ name, tag })
        );
        // Rename "image" to "name" for each mcrImages item.
        const mcrImagesArray = data.mcrImages.map((img: any) => ({
          name: img.image,
          releases: img.releases,
        }));
        setAzureImages(azureImagesArray);
        setMcrImages(mcrImagesArray);
        setLoading(false);
      })
      .catch((error) => {
        console.error("Error fetching data:", error);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
        }}
      >
        <div style={{ fontWeight: 'bold' }}>Fetching Images...</div>
      </div>
    );
  }
  

  return (
    <div className="min-h-screen bg-background px-4 md:px-8 lg:px-12">
      <div className="container py-8 space-y-8 max-w-7xl mx-auto">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">
            Latest Docker Image Releases
          </h1>
          <p className="text-muted-foreground">
            Track the latest versions of Azure and Microsoft Container Registry images
          </p>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Azure Images</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Image Name</TableHead>
                    <TableHead>Latest Tag</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {azureImages.map((image) => (
                    <TableRow key={image.name}>
                      <TableCell className="font-medium">{image.name}</TableCell>
                      <TableCell>
                        {image.tag.startsWith("Error") ? (
                          <Badge variant="destructive">{image.tag}</Badge>
                        ) : (
                          <Badge variant="secondary">{image.tag}</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="space-y-4">
            <h2 className="text-2xl font-bold tracking-tight">MCR Images</h2>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-2">
              {mcrImages.map((mcr) => (
                <Card key={mcr.name} className="flex flex-col">
                  <CardHeader>
                    <CardTitle className="text-base">
                      <ScrollArea className="h-[60px]">{mcr.name}</ScrollArea>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex-1">
                    <div className="space-y-2">
                      {mcr.releases.map((release, index) => (
                        <div
                          key={release.tag}
                          className="flex flex-col space-y-1 rounded-md border p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <code
                              className={`text-sm bg-muted rounded px-1 py-0.5 ${
                                index === 0 ? "font-bold" : ""
                              }`}
                            >
                              {release.tag}
                            </code>
                            <CopyButton text={release.tag} />
                          </div>
                          <div className="flex items-center text-sm text-muted-foreground">
                            <CalendarIcon className="mr-1 h-3 w-3" />
                            {new Date(release.created).toLocaleDateString(undefined, {
                              year: "numeric",
                              month: "long",
                              day: "numeric",
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}