import { useEffect, useRef } from "react";
import "mapillary-js/dist/mapillary.css";
import { Viewer } from "mapillary-js";


interface Props {
  imageId: string;
}


export default function StreetView({ imageId }: Props) {

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);


  useEffect(() => {

    if (!containerRef.current || !imageId) return;


    const token = import.meta.env.VITE_MAPILLARY_TOKEN;


    const viewer = new Viewer({
      accessToken: token,
      container: containerRef.current,
      imageId: imageId,
      component: {
        cover: true,
      },
    });


    viewerRef.current = viewer;


    return () => {
      viewer.remove();
      viewerRef.current = null;
    };


  }, [imageId]);



  if (!imageId) {
    return (
      <div
        style={{
          width:"100%",
          height:"100%",
          display:"flex",
          alignItems:"center",
          justifyContent:"center",
          background:"#eee",
          color:"#888",
        }}
      >
        画像を読み込み中...
      </div>
    );
  }



  return (
    <div
      ref={containerRef}
      style={{
        width:"100%",
        height:"100%",
        borderRadius:12,
        overflow:"hidden",
      }}
    />
  );
}