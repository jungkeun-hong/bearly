import type { Metadata } from "next"
import ReportApp from "@/components/twin/report-app"

// The demo stage. Everything from /test2 and /test3 in one page, live only:
// the picture is the glasses when they are sending, otherwise this computer's camera. No recorded footage.

export const metadata: Metadata = {
  title: { absolute: "Bearly | Too lazy to shop? Just say yup." },
  robots: { index: false, follow: false },
}

export default function Page() {
  return <ReportApp annotate spatial demo />
}
