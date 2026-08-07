// The Kaiibi mark, inlined as a data URI.
//
// A data URI rather than a bundled asset reference because the printed receipt
// is built as an HTML *string* (see buildReceiptHtml) and handed to a print
// iframe on web or expo-print's printToFileAsync on native. Neither resolves a
// relative path or a Metro asset id -- an <img src="../assets/..."> renders as
// a broken-image box on paper, which is a thing you only discover after
// printing. Inlined, it cannot fail to resolve.
//
// Generated from assets/images/kaiibi.jpeg (a white K on black), re-encoded as
// a 40px PNG: the source is 1280px and 37KB, which is absurd for something
// printed 14px wide, and JPEG artefacts around a hard-edged monochrome logo
// print as grey mush on a thermal head.
export const KAIIBI_MARK_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAKKADAAQAAAABAAAAKAAAAAB65masAAADcUlEQVRYCe2WSyitURTHnQd5RcqMAfIYGBkodAYGMjllYOpdByOPAcmjhAkjEyYSqUOhmHjMJEKdvJKRYoC8Qylv5/id+3X3/e52Lt+Oe9Xt7MFp7fWt9f/vvfZ6HJPJZAr4jmX+DlIvp5/4n0XeH+r/P9QWIw3E4/FIkZC8JAO+SgaSO1vrW5WkATQ2Nra3tzc0NNRsNj8/Py8tLbW3twtojbWxsTEnJ+f+/j4wMHBtba21tfXp6UmC+m3743DeH0CFrBewTklJAf3w8NDlcr28vMzOzqIUNshVVVUYbG9v83t+fp6WlqY3EJZCgOuXv9BKAhDJyckgVlZWIm9ubs7MzAhchPz8fE7T1NTU2dl5c3OTnZ0tvkpQ+q1CHcMNon6hyczMdDqdPT09l5eXdXV1HG5+fh4CvZlP+eM3Fm4SHKyJiYkTExPT09OQjY6ONjc3j4yMSGbCXRIUiCXP6OjoycnJvb098g76/v7+rq4uyeadrTIxFyI1goKChoeHg4ODie3Q0NDKykptbS00Bq+LpTIxRTI1NdXd3Z2enp6Xl0dC3d7eFhUVPT4+GmeFWCG5tAu1tbVFRUU5HI6CgoKKior4+HiymsxSYlW7MdAkVEREBM2htLQ0KyuLi5aUlOzu7qqyQqxQx8XFxTabjZDW19fztHd3d0dHRzSNmJgYIzgcTr+MEvO0ZO/x8TGvy9PSOOkYqampV1dXc3NzYWFhqtxGickg4jw2NkaEz87OHh4e6F9Wq9Vut7vdHmqJ2yhxGyXmiouLizzwwsICHTs3N5d5MDg4CBmFxJkaGhr+CjHQ5eXlQG9tbVFOCIWFhShbWlqQeQVk0ts4t0Ide0dKQIDb7bZYLAi06KSkpI6ODrK6urqa9kkn2d/fX11d1cKOzXtLn2k+ZZy16VRWVoa8vr6uTSdkTkD/Ir0zMjLCw8P5tLOzw/Dmk08ovdKAxc95PD4+ztw9OTkRYxECXn15eZm6qqmp6evrI+AMDJQfchsiTkhIIJ5MeDoUFTUwMCBwEeLi4jY2Nq6vr09PTw8ODvjl/wnvor+fbxnn9xchjYyM1GyAoIcw8IULt6SOQ0JCEFBiAOvFxYW2FWaS4D2KpPK5lVAkL+krCJLBW0yjxG89P6lRm06fJNO7+4n10fgS+U9Z5k+uLwmvEZBvy+pXNvGKWaCnlKMAAAAASUVORK5CYII=';
