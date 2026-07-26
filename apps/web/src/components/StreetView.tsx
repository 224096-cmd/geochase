interface Props {
  imageUrl: string;
}

// Mapillaryの静止画をフルスクリーン表示するだけのシンプル実装。
// 360度パノラマ操作が必要なら Mapillary JS SDK
// (https://www.mapillary.com/developer/api-documentation#mapillary-js) に差し替え可能。
export default function StreetView({ imageUrl }: Props) {
  if (!imageUrl) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#eee",
          color: "#888",
        }}
      >
        画像を読み込み中...
      </div>
    );
  }

  return (
    <img
      src={imageUrl}
      alt="street view"
      style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 12 }}
    />
  );
}
