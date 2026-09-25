import { useState } from "react";
import { Redirect, Route, Switch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/api";
import { CommandBar } from "./components/CommandBar";
import { KeyboardCheatsheet } from "./components/KeyboardCheatsheet";
import Dashboard from "./pages/Dashboard";
import Setup from "./pages/Setup";
import Skills from "./pages/Skills";
import Adopt from "./pages/Adopt";
import Sync from "./pages/Sync";
import Devices from "./pages/Devices";
import Graph from "./pages/Graph";
import Settings from "./pages/Settings";
import NotionConflicts from "./pages/NotionConflicts";
import NotionReview from "./pages/NotionReview";

export default function App() {
  const { data: config, isLoading } = useQuery({
    queryKey: ["config"],
    queryFn: () => api.getConfig(),
  });
  const [cmdOpen, setCmdOpen] = useState(false);

  if (isLoading) return null;

  const needsSetup = !config?.vault_path;

  return (
    <>
      <Switch>
        <Route path="/setup" component={Setup} />
        {needsSetup ? (
          <Route>
            <Redirect to="/setup" />
          </Route>
        ) : (
          <>
            <Route path="/" component={Dashboard} />
            <Route path="/skills" component={Skills} />
            <Route path="/skills/:name" component={Skills} />
            <Route path="/adopt" component={Adopt} />
            <Route path="/sync" component={Sync} />
            <Route path="/devices" component={Devices} />
            <Route path="/devices/:name" component={Devices} />
            <Route path="/graph" component={Graph} />
            <Route path="/settings" component={Settings} />
            <Route path="/notion/conflicts" component={NotionConflicts} />
            <Route path="/notion/push">{() => <NotionReview key="push" direction="push" />}</Route>
            <Route path="/notion/pull">{() => <NotionReview key="pull" direction="pull" />}</Route>
            <Route>
              <Redirect to="/" />
            </Route>
          </>
        )}
      </Switch>

      <CommandBar open={cmdOpen} setOpen={setCmdOpen} />
      <KeyboardCheatsheet />
    </>
  );
}
