import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast !rounded-md !border !border-border !bg-card !text-foreground !text-[13px] !shadow-lg",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
          cancelButton: "!bg-secondary !text-muted-foreground",
          success: "!border-success/40",
          error: "!border-destructive/40",
          warning: "!border-warning/40",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
